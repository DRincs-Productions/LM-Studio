use std::{path::Path, sync::Mutex};

pub mod runtime;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 3;
const INITIAL_SCHEMA: &str = include_str!("../migrations/0001_initial.sql");
const SINGLE_ACTIVE_JOB_MIGRATION: &str = include_str!("../migrations/0002_single_active_job.sql");
const MANUAL_RETRY_MIGRATION: &str = include_str!("../migrations/0003_manual_retry.sql");

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("invalid request: {0}")]
    InvalidRequest(&'static str),
    #[error("idempotency_conflict")]
    IdempotencyConflict,
    #[error("job_not_found")]
    JobNotFound,
    #[error("invalid job state transition from {from:?} to {to:?}")]
    InvalidTransition { from: JobState, to: JobState },
    #[error("database lock poisoned")]
    LockPoisoned,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    CancelRequested,
    Cancelled,
    Interrupted,
}

impl JobState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::CancelRequested => "cancel_requested",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    fn parse(value: &str) -> Result<Self, rusqlite::Error> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancel_requested" => Ok(Self::CancelRequested),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown job state: {value}").into(),
            )),
        }
    }

    fn allows(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Queued, Self::Running)
                | (Self::Queued, Self::Cancelled)
                | (Self::Running, Self::Succeeded)
                | (Self::Running, Self::Failed)
                | (Self::Running, Self::CancelRequested)
                | (Self::Running, Self::Interrupted)
                | (Self::CancelRequested, Self::Succeeded)
                | (Self::CancelRequested, Self::Failed)
                | (Self::CancelRequested, Self::Cancelled)
                | (Self::CancelRequested, Self::Interrupted)
        )
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub uid: String,
    pub client_id: String,
    pub request_id: String,
    pub operation: String,
    pub payload_version: u32,
    pub payload: serde_json::Value,
    pub retry_of_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub job_id: String,
    pub uid: String,
    pub client_id: String,
    pub request_id: String,
    pub state: JobState,
    pub fifo_sequence: i64,
    pub engine: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub timeout_at: Option<String>,
    pub error_code: Option<String>,
    pub result_manifest: Option<serde_json::Value>,
    pub retry_of_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub event_id: i64,
    pub job_id: String,
    pub occurred_at: String,
    pub event_type: String,
    pub previous_state: Option<JobState>,
    pub new_state: Option<JobState>,
    pub message_redacted: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedJob {
    pub job: JobRecord,
    pub duplicate: bool,
}

pub enum JobExecutionOutcome {
    Succeeded {
        result_manifest: Option<serde_json::Value>,
    },
    Failed {
        error_code: String,
        message_redacted: String,
        result_manifest: Option<serde_json::Value>,
    },
    Cancelled {
        message_redacted: String,
        result_manifest: Option<serde_json::Value>,
    },
    Interrupted {
        message_redacted: String,
        result_manifest: Option<serde_json::Value>,
    },
}

pub struct JobStore {
    connection: Mutex<Connection>,
}

impl JobStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::InvalidRequest(
                "database schema is newer than this binary",
            ));
        }
        if version < 1 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(INITIAL_SCHEMA)?;
            transaction.pragma_update(None, "user_version", 1)?;
            transaction.commit()?;
        }
        if version < 2 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(SINGLE_ACTIVE_JOB_MIGRATION)?;
            transaction.pragma_update(None, "user_version", 2)?;
            transaction.commit()?;
        }
        if version < 3 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(MANUAL_RETRY_MIGRATION)?;
            transaction.pragma_update(None, "user_version", 3)?;
            transaction.commit()?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn submit(&self, request: SubmitRequest) -> Result<AcceptedJob, StoreError> {
        validate_request(&request)?;
        let payload_json = serde_json::to_string(&request.payload)?;
        let idempotency_material = match request.retry_of_job_id.as_deref() {
            Some(source_job_id) => serde_json::to_vec(&(
                &request.operation,
                request.payload_version,
                &request.payload,
                Some(source_job_id),
            ))?,
            None => serde_json::to_vec(&(
                &request.operation,
                request.payload_version,
                &request.payload,
            ))?,
        };
        let payload_hash = format!("{:x}", Sha256::digest(idempotency_material));
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT payload_hash, job_id FROM requests \
                 WHERE uid = ?1 AND client_id = ?2 AND request_id = ?3",
                params![request.uid, request.client_id, request.request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((existing_hash, job_id)) = existing {
            if existing_hash != payload_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let job = load_job(&transaction, &job_id)?.ok_or(StoreError::JobNotFound)?;
            transaction.commit()?;
            return Ok(AcceptedJob {
                job,
                duplicate: true,
            });
        }

        let now = timestamp();
        let job_id = Uuid::new_v4().to_string();
        let fifo_sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(fifo_sequence), 0) + 1 FROM jobs",
            [],
            |row| row.get(0),
        )?;

        transaction.execute(
            "INSERT INTO requests (
                uid, client_id, request_id, operation, payload_version,
                payload_hash, payload_json, created_at, job_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                request.uid,
                request.client_id,
                request.request_id,
                request.operation,
                request.payload_version,
                payload_hash,
                payload_json,
                now,
                job_id,
            ],
        )?;
        transaction.execute(
            "INSERT INTO jobs (
                job_id, uid, client_id, request_id, state, fifo_sequence, created_at, retry_of_job_id
             ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7)",
            params![
                job_id,
                request.uid,
                request.client_id,
                request.request_id,
                fifo_sequence,
                now,
                request.retry_of_job_id
            ],
        )?;
        append_event(
            &transaction,
            &job_id,
            "job.accepted",
            None,
            Some(JobState::Queued),
            "Request accepted",
        )?;
        let job = load_job(&transaction, &job_id)?.ok_or(StoreError::JobNotFound)?;
        transaction.commit()?;
        Ok(AcceptedJob {
            job,
            duplicate: false,
        })
    }

    pub fn get(&self, job_id: &str) -> Result<Option<JobRecord>, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        Ok(load_job(&connection, job_id)?)
    }

    /// Returns the immutable operation envelope associated with a persisted job.
    pub fn request_context(&self, job_id: &str) -> Result<Option<serde_json::Value>, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let serialized: Option<(String, u32, String)> = connection
            .query_row(
                "SELECT r.operation, r.payload_version, r.payload_json FROM requests r INNER JOIN jobs j ON j.request_id = r.request_id AND j.uid = r.uid AND j.client_id = r.client_id WHERE j.job_id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        serialized
            .map(|(operation, version, payload)| {
                let payload: serde_json::Value = serde_json::from_str(&payload)?;
                Ok(serde_json::json!({ "operation": operation, "payloadVersion": version, "payload": payload }))
            })
            .transpose()
    }

    pub fn get_by_request(
        &self,
        uid: &str,
        client_id: &str,
        request_id: &str,
    ) -> Result<Option<JobRecord>, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let job_id: Option<String> = connection
            .query_row(
                "SELECT job_id FROM requests WHERE uid = ?1 AND client_id = ?2 AND request_id = ?3",
                params![uid, client_id, request_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(job_id
            .map(|id| load_job(&connection, &id))
            .transpose()
            .map(Option::flatten)?)
    }

    /// Queues a new run only when the authorized caller explicitly retries a failed job.
    /// The retry request ID is idempotent, and interrupted jobs are never replayed.
    pub fn retry_failed(
        &self,
        uid: &str,
        client_id: &str,
        job_id: &str,
        retry_request_id: &str,
    ) -> Result<AcceptedJob, StoreError> {
        let source = self
            .get(job_id)?
            .filter(|job| job.uid == uid && job.client_id == client_id)
            .ok_or(StoreError::JobNotFound)?;
        if source.state != JobState::Failed {
            return Err(StoreError::InvalidRequest(
                "only failed jobs can be manually retried",
            ));
        }
        if Uuid::parse_str(retry_request_id).is_err() {
            return Err(StoreError::InvalidRequest(
                "retry request ID must be a UUID",
            ));
        }
        let context = self
            .request_context(job_id)?
            .ok_or(StoreError::JobNotFound)?;
        let operation = context
            .get("operation")
            .and_then(serde_json::Value::as_str)
            .ok_or(StoreError::InvalidRequest(
                "original operation is unavailable",
            ))?;
        let payload_version = context
            .get("payloadVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or(StoreError::InvalidRequest(
                "original payload version is unavailable",
            ))? as u32;
        let payload = context
            .get("payload")
            .cloned()
            .ok_or(StoreError::InvalidRequest(
                "original payload is unavailable",
            ))?;
        let accepted = self.submit(SubmitRequest {
            uid: uid.to_owned(),
            client_id: client_id.to_owned(),
            request_id: retry_request_id.to_owned(),
            operation: operation.to_owned(),
            payload_version,
            payload,
            retry_of_job_id: Some(job_id.to_owned()),
        })?;
        if !accepted.duplicate {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StoreError::LockPoisoned)?;
            let transaction = connection.unchecked_transaction()?;
            append_event(
                &transaction,
                &accepted.job.job_id,
                "job.retry_requested",
                None,
                Some(JobState::Queued),
                "Manual retry explicitly requested by the authorized client",
            )?;
            transaction.commit()?;
        }
        Ok(accepted)
    }

    pub fn next_queued(&self) -> Result<Option<JobRecord>, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let job_id: Option<String> = connection
            .query_row(
                "SELECT job_id FROM jobs WHERE state = 'queued' ORDER BY fifo_sequence LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(job_id
            .map(|id| load_job(&connection, &id))
            .transpose()
            .map(Option::flatten)?)
    }

    /// Atomically claims the oldest queued job when no job is already active.
    /// Callers must use this method instead of selecting and starting separately.
    pub fn claim_next_queued(&self) -> Result<Option<JobRecord>, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE state IN ('running', 'cancel_requested'))",
            [],
            |row| row.get(0),
        )?;
        if active {
            return Ok(None);
        }

        let job_id: Option<String> = transaction
            .query_row(
                "SELECT job_id FROM jobs WHERE state = 'queued' ORDER BY fifo_sequence LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(job_id) = job_id else {
            return Ok(None);
        };

        let current = load_job(&transaction, &job_id)?.ok_or(StoreError::JobNotFound)?;
        let now = timestamp();
        transaction.execute(
            "UPDATE jobs SET state = 'running', started_at = COALESCE(started_at, ?2) WHERE job_id = ?1",
            params![job_id, now],
        )?;
        transaction.execute(
            "INSERT INTO job_attempts (job_id, attempt_number, cause, approved_by, started_at)
             VALUES (?1, 1, ?2, ?3, ?4)",
            params![
                job_id,
                if current.retry_of_job_id.is_some() {
                    "manual_retry"
                } else {
                    "initial_request"
                },
                if current.retry_of_job_id.is_some() {
                    "authorized_client"
                } else {
                    "client_request"
                },
                now
            ],
        )?;
        append_event(
            &transaction,
            &job_id,
            "job.state_changed",
            Some(current.state),
            Some(JobState::Running),
            "Job claimed by the Coordinator",
        )?;
        let job = load_job(&transaction, &job_id)?.ok_or(StoreError::JobNotFound)?;
        transaction.commit()?;
        Ok(Some(job))
    }

    pub fn list(
        &self,
        uid: &str,
        client_id: &str,
        limit: u32,
    ) -> Result<Vec<JobRecord>, StoreError> {
        if !(1..=100).contains(&limit) {
            return Err(StoreError::InvalidRequest(
                "list limit must be between 1 and 100",
            ));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let mut statement = connection.prepare(
            "SELECT job_id, uid, client_id, request_id, state, fifo_sequence, engine,
                    created_at, started_at, finished_at, timeout_at, error_code, result_manifest, retry_of_job_id
             FROM jobs WHERE uid = ?1 AND client_id = ?2
             ORDER BY fifo_sequence DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![uid, client_id, limit], row_to_job)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_events(
        &self,
        uid: &str,
        client_id: &str,
        job_id: &str,
        limit: u32,
    ) -> Result<Vec<JobEvent>, StoreError> {
        if !(1..=200).contains(&limit) {
            return Err(StoreError::InvalidRequest(
                "event limit must be between 1 and 200",
            ));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let mut statement = connection.prepare(
            "SELECT e.event_id, e.job_id, e.occurred_at, e.event_type,
                    e.previous_state, e.new_state, e.message_redacted
             FROM job_events e
             INNER JOIN jobs j ON j.job_id = e.job_id
             WHERE j.uid = ?1 AND j.client_id = ?2 AND e.job_id = ?3
             ORDER BY e.event_id DESC LIMIT ?4",
        )?;
        let rows = statement.query_map(params![uid, client_id, job_id, limit], row_to_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn transition(
        &self,
        job_id: &str,
        next: JobState,
        error_code: Option<&str>,
        message_redacted: &str,
    ) -> Result<JobRecord, StoreError> {
        self.transition_with_manifest(job_id, next, error_code, None, message_redacted)
    }

    pub fn transition_with_manifest(
        &self,
        job_id: &str,
        next: JobState,
        error_code: Option<&str>,
        result_manifest: Option<&serde_json::Value>,
        message_redacted: &str,
    ) -> Result<JobRecord, StoreError> {
        let manifest_json = result_manifest.map(serde_json::to_string).transpose()?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_job(&transaction, job_id)?.ok_or(StoreError::JobNotFound)?;
        if !current.state.allows(next) {
            return Err(StoreError::InvalidTransition {
                from: current.state,
                to: next,
            });
        }
        let now = timestamp();
        let started_at = (next == JobState::Running).then_some(now.as_str());
        let finished_at = next.is_terminal().then_some(now.as_str());
        transaction.execute(
            "UPDATE jobs SET state = ?2,
                started_at = COALESCE(started_at, ?3),
                finished_at = COALESCE(?4, finished_at),
                error_code = ?5,
                result_manifest = COALESCE(?6, result_manifest)
             WHERE job_id = ?1",
            params![
                job_id,
                next.as_str(),
                started_at,
                finished_at,
                error_code,
                manifest_json
            ],
        )?;
        if next == JobState::Running {
            transaction.execute(
                "INSERT INTO job_attempts (job_id, attempt_number, cause, approved_by, started_at)
                 VALUES (?1, 1, 'initial_request', 'client_request', ?2)",
                params![job_id, now],
            )?;
        } else if next.is_terminal() {
            transaction.execute(
                "UPDATE job_attempts SET finished_at = ?2, outcome = ?3 WHERE job_id = ?1 AND finished_at IS NULL",
                params![job_id, now, next.as_str()],
            )?;
        }
        append_event(
            &transaction,
            job_id,
            "job.state_changed",
            Some(current.state),
            Some(next),
            message_redacted,
        )?;
        let job = load_job(&transaction, job_id)?.ok_or(StoreError::JobNotFound)?;
        transaction.commit()?;
        Ok(job)
    }

    /// Claims one FIFO job, calls the host-provided executor once, and persists its outcome.
    /// This method never retries a job and does not provide an executor itself.
    pub fn run_next(
        &self,
        executor: impl FnOnce(&JobRecord, &JobStore) -> JobExecutionOutcome,
    ) -> Result<Option<JobRecord>, StoreError> {
        let Some(job) = self.claim_next_queued()? else {
            return Ok(None);
        };
        let outcome = executor(&job, self);
        let current_state = self.get(&job.job_id)?.ok_or(StoreError::JobNotFound)?.state;
        let completed = match outcome {
            JobExecutionOutcome::Succeeded { result_manifest } => self.transition_with_manifest(
                &job.job_id,
                JobState::Succeeded,
                None,
                result_manifest.as_ref(),
                "Executor completed the job",
            )?,
            JobExecutionOutcome::Failed {
                error_code,
                message_redacted,
                result_manifest,
            } => self.transition_with_manifest(
                &job.job_id,
                JobState::Failed,
                Some(&error_code),
                result_manifest.as_ref(),
                &message_redacted,
            )?,
            JobExecutionOutcome::Cancelled {
                message_redacted,
                result_manifest,
            } if current_state == JobState::CancelRequested => self.transition_with_manifest(
                &job.job_id,
                JobState::Cancelled,
                None,
                result_manifest.as_ref(),
                &message_redacted,
            )?,
            JobExecutionOutcome::Cancelled { .. } => self.transition(
                &job.job_id,
                JobState::Failed,
                Some("executor_cancelled_without_request"),
                "Executor stopped without a recorded cancellation request",
            )?,
            JobExecutionOutcome::Interrupted {
                message_redacted,
                result_manifest,
            } => self.transition_with_manifest(
                &job.job_id,
                JobState::Interrupted,
                Some("executor_interrupted"),
                result_manifest.as_ref(),
                &message_redacted,
            )?,
        };
        Ok(Some(completed))
    }

    pub fn mark_running_jobs_interrupted(&self) -> Result<usize, StoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = transaction
            .prepare("SELECT job_id FROM jobs WHERE state IN ('running', 'cancel_requested')")?;
        let job_ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let now = timestamp();
        for job_id in &job_ids {
            let current = load_job(&transaction, job_id)?.ok_or(StoreError::JobNotFound)?;
            transaction.execute(
                "UPDATE jobs SET state = 'interrupted', finished_at = ?2, error_code = 'interrupted_after_restart' WHERE job_id = ?1",
                params![job_id, now],
            )?;
            transaction.execute(
                "UPDATE job_attempts SET finished_at = ?2, outcome = 'interrupted' WHERE job_id = ?1 AND finished_at IS NULL",
                params![job_id, now],
            )?;
            append_event(
                &transaction,
                job_id,
                "job.interrupted_after_restart",
                Some(current.state),
                Some(JobState::Interrupted),
                "The previous process ended before job completion could be verified",
            )?;
        }
        transaction.commit()?;
        Ok(job_ids.len())
    }
}

fn validate_request(request: &SubmitRequest) -> Result<(), StoreError> {
    if request.uid.trim().is_empty() {
        return Err(StoreError::InvalidRequest("uid is required"));
    }
    if request.client_id.trim().is_empty() {
        return Err(StoreError::InvalidRequest("clientId is required"));
    }
    if request.request_id.trim().is_empty() {
        return Err(StoreError::InvalidRequest("requestId is required"));
    }
    if request.operation.trim().is_empty() {
        return Err(StoreError::InvalidRequest("operation is required"));
    }
    if request.operation.len() > 100 {
        return Err(StoreError::InvalidRequest("operation is too long"));
    }
    if request.payload_version != 1 {
        return Err(StoreError::InvalidRequest("unsupported payload version"));
    }
    if request
        .retry_of_job_id
        .as_ref()
        .is_some_and(|value| Uuid::parse_str(value).is_err())
    {
        return Err(StoreError::InvalidRequest(
            "retry source job ID must be a UUID",
        ));
    }
    Ok(())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn append_event(
    transaction: &Transaction<'_>,
    job_id: &str,
    event_type: &str,
    previous_state: Option<JobState>,
    new_state: Option<JobState>,
    message_redacted: &str,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO job_events (job_id, occurred_at, event_type, previous_state, new_state, message_redacted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            job_id,
            timestamp(),
            event_type,
            previous_state.map(JobState::as_str),
            new_state.map(JobState::as_str),
            message_redacted
        ],
    )?;
    Ok(())
}

fn load_job(connection: &Connection, job_id: &str) -> Result<Option<JobRecord>, rusqlite::Error> {
    connection
        .query_row(
            "SELECT job_id, uid, client_id, request_id, state, fifo_sequence, engine,
                created_at, started_at, finished_at, timeout_at, error_code, result_manifest, retry_of_job_id
         FROM jobs WHERE job_id = ?1",
            [job_id],
            row_to_job,
        )
        .optional()
}

fn row_to_job(row: &rusqlite::Row<'_>) -> Result<JobRecord, rusqlite::Error> {
    let state: String = row.get(4)?;
    let result_manifest: Option<String> = row.get(12)?;
    let result_manifest = result_manifest
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    12,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })
        })
        .transpose()?;
    Ok(JobRecord {
        job_id: row.get(0)?,
        uid: row.get(1)?,
        client_id: row.get(2)?,
        request_id: row.get(3)?,
        state: JobState::parse(&state)?,
        fifo_sequence: row.get(5)?,
        engine: row.get(6)?,
        created_at: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
        timeout_at: row.get(10)?,
        error_code: row.get(11)?,
        result_manifest,
        retry_of_job_id: row.get(13)?,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> Result<JobEvent, rusqlite::Error> {
    let previous_state: Option<String> = row.get(4)?;
    let new_state: Option<String> = row.get(5)?;
    Ok(JobEvent {
        event_id: row.get(0)?,
        job_id: row.get(1)?,
        occurred_at: row.get(2)?,
        event_type: row.get(3)?,
        previous_state: previous_state
            .map(|value| JobState::parse(&value))
            .transpose()?,
        new_state: new_state.map(|value| JobState::parse(&value)).transpose()?,
        message_redacted: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(request_id: &str, value: i32) -> SubmitRequest {
        SubmitRequest {
            uid: "user-1".into(),
            client_id: "client-1".into(),
            request_id: request_id.into(),
            operation: "narrative.generate".into(),
            payload_version: 1,
            payload: serde_json::json!({ "seed": value }),
            retry_of_job_id: None,
        }
    }

    #[test]
    fn duplicate_submit_returns_the_original_job_and_conflicting_payload_fails() {
        let store = JobStore::open_in_memory().unwrap();
        let first = store.submit(request("request-1", 1)).unwrap();
        let duplicate = store.submit(request("request-1", 1)).unwrap();
        assert_eq!(first.job.job_id, duplicate.job.job_id);
        assert!(!first.duplicate);
        assert!(duplicate.duplicate);
        assert!(matches!(
            store.submit(request("request-1", 2)),
            Err(StoreError::IdempotencyConflict)
        ));
        let mut changed_operation = request("request-1", 1);
        changed_operation.operation = "image.generate".into();
        assert!(matches!(
            store.submit(changed_operation),
            Err(StoreError::IdempotencyConflict)
        ));
    }

    #[test]
    fn queued_jobs_are_returned_in_fifo_order() {
        let store = JobStore::open_in_memory().unwrap();
        let first = store.submit(request("request-1", 1)).unwrap();
        let second = store.submit(request("request-2", 2)).unwrap();
        assert_eq!(
            store.next_queued().unwrap().unwrap().job_id,
            first.job.job_id
        );
        assert!(second.job.fifo_sequence > first.job.fifo_sequence);
    }

    #[test]
    fn event_history_is_scoped_to_the_job_owner() {
        let store = JobStore::open_in_memory().unwrap();
        let accepted = store.submit(request("request-1", 1)).unwrap();
        let events = store
            .list_events("user-1", "client-1", &accepted.job.job_id, 10)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "job.accepted");
        assert!(
            store
                .list_events("another-user", "client-1", &accepted.job.job_id, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn claiming_is_fifo_single_active_and_skips_cancelled_entries() {
        let store = JobStore::open_in_memory().unwrap();
        let cancelled = store.submit(request("request-1", 1)).unwrap();
        let next = store.submit(request("request-2", 2)).unwrap();
        store
            .transition(
                &cancelled.job.job_id,
                JobState::Cancelled,
                None,
                "Cancelled before start",
            )
            .unwrap();

        let claimed = store.claim_next_queued().unwrap().unwrap();
        assert_eq!(claimed.job_id, next.job.job_id);
        assert_eq!(claimed.state, JobState::Running);
        assert!(store.claim_next_queued().unwrap().is_none());
    }

    #[test]
    fn concurrent_claims_cannot_start_two_jobs() {
        let store = std::sync::Arc::new(JobStore::open_in_memory().unwrap());
        store.submit(request("request-1", 1)).unwrap();
        store.submit(request("request-2", 2)).unwrap();
        let callers = (0..2)
            .map(|_| {
                let store = std::sync::Arc::clone(&store);
                std::thread::spawn(move || store.claim_next_queued().unwrap())
            })
            .collect::<Vec<_>>();

        let claimed = callers
            .into_iter()
            .filter_map(|caller| caller.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].state, JobState::Running);
        assert!(store.claim_next_queued().unwrap().is_none());
    }

    #[test]
    fn run_next_persists_executor_outcomes_without_automatic_retries() {
        let store = JobStore::open_in_memory().unwrap();
        let first = store.submit(request("request-1", 1)).unwrap();
        store.submit(request("request-2", 2)).unwrap();

        let succeeded = store
            .run_next(|job, _store| {
                assert_eq!(job.job_id, first.job.job_id);
                JobExecutionOutcome::Succeeded {
                    result_manifest: Some(serde_json::json!({ "artifactCount": 1 })),
                }
            })
            .unwrap()
            .unwrap();
        assert_eq!(succeeded.state, JobState::Succeeded);
        assert_eq!(
            succeeded.result_manifest,
            Some(serde_json::json!({ "artifactCount": 1 }))
        );

        let failed = store
            .run_next(|_, _store| JobExecutionOutcome::Failed {
                error_code: "engine_unavailable".into(),
                message_redacted: "Configured executor is unavailable".into(),
                result_manifest: None,
            })
            .unwrap()
            .unwrap();
        assert_eq!(failed.state, JobState::Failed);
        assert_eq!(failed.error_code.as_deref(), Some("engine_unavailable"));
        assert!(
            store
                .run_next(|_, _| panic!("there must be no automatic retry"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn manual_retry_creates_one_linked_queued_job_only_for_the_owner() {
        let store = JobStore::open_in_memory().unwrap();
        let original = store.submit(request("request-original", 7)).unwrap();
        store
            .run_next(|_, _| JobExecutionOutcome::Failed {
                error_code: "engine_unavailable".into(),
                message_redacted: "Configured executor is unavailable".into(),
                result_manifest: None,
            })
            .unwrap()
            .unwrap();

        assert!(matches!(
            store.retry_failed(
                "other-user",
                "client-1",
                &original.job.job_id,
                "6a17f3cb-a44b-46ab-9c5f-94e08f123ed1"
            ),
            Err(StoreError::JobNotFound)
        ));
        let retry_id = "6a17f3cb-a44b-46ab-9c5f-94e08f123ed1";
        let retry = store
            .retry_failed("user-1", "client-1", &original.job.job_id, retry_id)
            .unwrap();
        assert!(!retry.duplicate);
        assert_eq!(retry.job.state, JobState::Queued);
        assert_eq!(
            retry.job.retry_of_job_id.as_deref(),
            Some(original.job.job_id.as_str())
        );
        assert_eq!(
            store.request_context(&retry.job.job_id).unwrap(),
            store.request_context(&original.job.job_id).unwrap(),
        );

        let duplicate = store
            .retry_failed("user-1", "client-1", &original.job.job_id, retry_id)
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.job.job_id, retry.job.job_id);

        let claimed = store.claim_next_queued().unwrap().unwrap();
        assert_eq!(claimed.job_id, retry.job.job_id);
        let connection = store.connection.lock().unwrap();
        let (cause, approved_by): (String, String) = connection.query_row(
            "SELECT cause, approved_by FROM job_attempts WHERE job_id = ?1 AND attempt_number = 1",
            [&retry.job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(cause, "manual_retry");
        assert_eq!(approved_by, "authorized_client");
    }

    #[test]
    fn manual_retry_refuses_interrupted_jobs() {
        let store = JobStore::open_in_memory().unwrap();
        let original = store.submit(request("request-interrupted", 9)).unwrap();
        store.claim_next_queued().unwrap().unwrap();
        store.mark_running_jobs_interrupted().unwrap();
        assert!(matches!(
            store.retry_failed(
                "user-1",
                "client-1",
                &original.job.job_id,
                "b4d8bf97-77fd-4223-9981-84c6e87c9261"
            ),
            Err(StoreError::InvalidRequest(_))
        ));
    }

    #[test]
    fn run_next_marks_cancelled_only_after_a_cancel_request() {
        let store = JobStore::open_in_memory().unwrap();
        store.submit(request("request-1", 1)).unwrap();
        let result = store
            .run_next(|job, store| {
                store
                    .transition(
                        &job.job_id,
                        JobState::CancelRequested,
                        None,
                        "Cancellation requested",
                    )
                    .unwrap();
                JobExecutionOutcome::Cancelled {
                    message_redacted: "Executor confirmed cancellation".into(),
                    result_manifest: None,
                }
            })
            .unwrap()
            .unwrap();
        assert_eq!(result.state, JobState::Cancelled);
    }

    #[test]
    fn version_one_database_migration_marks_existing_active_jobs_interrupted() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection.execute_batch(INITIAL_SCHEMA).unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
            .execute(
                "INSERT INTO requests (
                uid, client_id, request_id, operation, payload_version,
                payload_hash, payload_json, created_at, job_id
            ) VALUES ('user-1', 'client-1', 'legacy-1', 'narrative.generate', 1,
                ?1, '{}', '2026-11-03T00:00:00Z', 'legacy-job-1')",
                ["a".repeat(64)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO jobs (
                job_id, uid, client_id, request_id, state, fifo_sequence, created_at, started_at
            ) VALUES ('legacy-job-1', 'user-1', 'client-1', 'legacy-1', 'running', 1,
                '2026-11-03T00:00:00Z', '2026-11-03T00:00:01Z')",
                [],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO job_attempts (job_id, attempt_number, cause, approved_by, started_at)
             VALUES ('legacy-job-1', 1, 'initial_request', 'client_request', '2026-11-03T00:00:01Z')",
            [],
        ).unwrap();

        let store = JobStore::from_connection(connection).unwrap();
        let job = store.get("legacy-job-1").unwrap().unwrap();
        assert_eq!(job.state, JobState::Interrupted);
        assert_eq!(
            job.error_code.as_deref(),
            Some("interrupted_during_single_active_migration")
        );
        let connection = store.connection.lock().unwrap();
        let events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM job_events WHERE job_id = 'legacy-job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 1);
    }

    #[test]
    fn state_changes_are_checked_and_restart_never_requeues_running_jobs() {
        let store = JobStore::open_in_memory().unwrap();
        let accepted = store.submit(request("request-1", 1)).unwrap();
        store
            .transition(&accepted.job.job_id, JobState::Running, None, "Job started")
            .unwrap();
        let interrupted = store.mark_running_jobs_interrupted().unwrap();
        assert_eq!(interrupted, 1);
        assert_eq!(
            store.get(&accepted.job.job_id).unwrap().unwrap().state,
            JobState::Interrupted
        );
        assert!(matches!(
            store.transition(
                &accepted.job.job_id,
                JobState::Succeeded,
                None,
                "late result"
            ),
            Err(StoreError::InvalidTransition { .. })
        ));
    }

    #[test]
    fn cancelling_a_queued_job_is_terminal_and_a_running_cancel_requires_confirmation() {
        let store = JobStore::open_in_memory().unwrap();
        let queued = store.submit(request("request-1", 1)).unwrap();
        assert_eq!(
            store
                .transition(
                    &queued.job.job_id,
                    JobState::Cancelled,
                    None,
                    "Cancelled before start",
                )
                .unwrap()
                .state,
            JobState::Cancelled
        );
        let active = store.submit(request("request-2", 2)).unwrap();
        store
            .transition(&active.job.job_id, JobState::Running, None, "Job started")
            .unwrap();
        store
            .transition(
                &active.job.job_id,
                JobState::CancelRequested,
                None,
                "Cancellation requested",
            )
            .unwrap();
        assert_eq!(
            store.get(&active.job.job_id).unwrap().unwrap().state,
            JobState::CancelRequested
        );
        assert!(store.next_queued().unwrap().is_none());
    }
}
