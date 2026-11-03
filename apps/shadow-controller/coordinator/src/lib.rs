use std::{path::Path, sync::Mutex};

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 2;
const INITIAL_SCHEMA: &str = include_str!("../migrations/0001_initial.sql");
const SINGLE_ACTIVE_JOB_MIGRATION: &str = include_str!("../migrations/0002_single_active_job.sql");

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedJob {
    pub job: JobRecord,
    pub duplicate: bool,
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
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn submit(&self, request: SubmitRequest) -> Result<AcceptedJob, StoreError> {
        validate_request(&request)?;
        let payload_json = serde_json::to_string(&request.payload)?;
        let idempotency_material = serde_json::to_vec(&(
            &request.operation,
            request.payload_version,
            &request.payload,
        ))?;
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
                job_id, uid, client_id, request_id, state, fifo_sequence, created_at
             ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6)",
            params![
                job_id,
                request.uid,
                request.client_id,
                request.request_id,
                fifo_sequence,
                now
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
             VALUES (?1, 1, 'initial_request', 'client_request', ?2)",
            params![job_id, now],
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
                    created_at, started_at, finished_at, timeout_at, error_code, result_manifest
             FROM jobs WHERE uid = ?1 AND client_id = ?2
             ORDER BY fifo_sequence DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![uid, client_id, limit], row_to_job)?;
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
                error_code = ?5
             WHERE job_id = ?1",
            params![job_id, next.as_str(), started_at, finished_at, error_code],
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
                created_at, started_at, finished_at, timeout_at, error_code, result_manifest
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
