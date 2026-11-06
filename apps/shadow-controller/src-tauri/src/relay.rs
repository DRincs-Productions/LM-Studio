use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use shadow_coordinator::{JobState, JobStore, SubmitRequest};
use tokio_tungstenite::{connect_async, tungstenite::{Message, client::IntoClientRequest, http::header::AUTHORIZATION, http::HeaderValue}};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_BACKOFF_SECONDS: u64 = 30;
const CONNECTION_REFRESH_SECONDS: u64 = 10 * 60;

pub fn start(data_dir: PathBuf, stop: Arc<AtomicBool>) -> Option<JoinHandle<()>> {
    let relay_base = match std::env::var("SHADOW_RELAY_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            append_log(&data_dir, "Relay connection is not configured; local Coordinator remains available");
            return None;
        }
    };
    let Some(relay_base) = normalize_relay_base(&relay_base) else {
        append_log(&data_dir, "Relay URL is invalid; use HTTPS/WSS or local HTTP/WS during development");
        return None;
    };

    thread::Builder::new()
        .name("shadow-relay-connection".to_owned())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(_) => {
                    append_log(&data_dir, "Could not start the relay networking runtime");
                    return;
                }
            };
            runtime.block_on(supervise(data_dir, relay_base, stop));
        })
        .ok()
}

fn normalize_relay_base(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    if let Some(host) = value.strip_prefix("https://") {
        return (!host.is_empty()).then(|| format!("wss://{host}"));
    }
    if let Some(host) = value.strip_prefix("wss://") {
        return (!host.is_empty()).then(|| format!("wss://{host}"));
    }
    for host in ["localhost", "127.0.0.1", "[::1]"] {
        if let Some(rest) = value.strip_prefix(&format!("http://{host}")) {
            if rest.is_empty() || rest.starts_with(':') || rest.starts_with('/') {
                return Some(format!("ws://{host}{rest}"));
            }
        }
        if let Some(rest) = value.strip_prefix(&format!("ws://{host}")) {
            if rest.is_empty() || rest.starts_with(':') || rest.starts_with('/') {
                return Some(format!("ws://{host}{rest}"));
            }
        }
    }
    None
}

async fn supervise(data_dir: PathBuf, relay_base: String, stop: Arc<AtomicBool>) {
    let store = match JobStore::open(data_dir.join("coordinator.sqlite3")) {
        Ok(store) => store,
        Err(_) => {
            append_log(&data_dir, "Could not open the Coordinator store for relay requests");
            return;
        }
    };
    let mut backoff = 2;

    while !stop.load(Ordering::Acquire) {
        let credentials = match crate::auth::relay_credentials() {
            Ok(Some(credentials)) => credentials,
            Ok(None) => {
                wait_or_stop(&stop, Duration::from_secs(15)).await;
                continue;
            }
            Err(_) => {
                append_log(&data_dir, "Relay connection is waiting for a valid signed-in and paired server");
                wait_or_stop(&stop, Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(MAX_BACKOFF_SECONDS);
                continue;
            }
        };

        let endpoint = format!(
            "{}/connect?role=server&serverId={}",
            relay_base,
            credentials.server_id
        );
        let result = connect_and_serve(
            &endpoint,
            &credentials.id_token,
            &credentials.uid,
            &store,
            Arc::clone(&stop),
        )
        .await;
        if stop.load(Ordering::Acquire) {
            break;
        }
        if result.is_err() {
            append_log(&data_dir, "Relay disconnected; the Coordinator will reconnect with backoff");
        }
        wait_or_stop(&stop, Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(MAX_BACKOFF_SECONDS);
    }
}

async fn connect_and_serve(
    endpoint: &str,
    id_token: &str,
    uid: &str,
    store: &JobStore,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| "invalid relay URL".to_owned())?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {id_token}"))
            .map_err(|_| "invalid Firebase authorization header".to_owned())?,
    );
    let connection = connect_async(request);
    tokio::pin!(connection);
    let (mut socket, _) = tokio::select! {
        result = &mut connection => result.map_err(|_| "relay connection failed".to_owned())?,
        _ = wait_until_stopped(&stop) => return Ok(()),
    };
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    let mut credential_check = tokio::time::interval(Duration::from_secs(15));
    let refresh = tokio::time::sleep(Duration::from_secs(CONNECTION_REFRESH_SECONDS));
    tokio::pin!(refresh);

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if stop.load(Ordering::Acquire) {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|_| "relay heartbeat failed".to_owned())?;
            }
            _ = wait_until_stopped(&stop) => {
                let _ = socket.close(None).await;
                return Ok(());
            }
            _ = credential_check.tick() => {
                if crate::auth::current_uid().ok().flatten().as_deref() != Some(uid) {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
            }
            _ = &mut refresh => return Ok(()),
            incoming = socket.next() => {
                let Some(incoming) = incoming else { return Err("relay closed the connection".to_owned()); };
                match incoming.map_err(|_| "relay message failed".to_owned())? {
                    Message::Text(text) => {
                        if text.len() > MAX_MESSAGE_BYTES { return Err("relay message exceeds size limit".to_owned()); }
                        let message: Value = serde_json::from_str(&text).map_err(|_| "relay sent invalid JSON".to_owned())?;
                        let mut reply = handle_request(store, uid, &message);
                        if let Some(object) = reply.as_object_mut() {
                            object.insert("uid".to_owned(), Value::String(uid.to_owned()));
                            if let Some(client_id) = message.get("clientId").and_then(Value::as_str) {
                                object.insert("clientId".to_owned(), Value::String(client_id.to_owned()));
                            }
                        }
                        let mut serialized = serde_json::to_string(&reply).map_err(|_| "could not encode relay response".to_owned())?;
                        if serialized.len() > MAX_MESSAGE_BYTES {
                            let mut compact = error_reply(
                                reply.get("replyTo").and_then(Value::as_str).map(str::to_owned),
                                "resource_unavailable",
                                "Response exceeds the relay message limit.",
                                false,
                            );
                            if let Some(object) = compact.as_object_mut() {
                                object.insert("uid".to_owned(), Value::String(uid.to_owned()));
                                if let Some(client_id) = message.get("clientId").and_then(Value::as_str) {
                                    object.insert("clientId".to_owned(), Value::String(client_id.to_owned()));
                                }
                            }
                            serialized = serde_json::to_string(&compact).map_err(|_| "could not encode relay error".to_owned())?;
                        }
                        socket.send(Message::Text(serialized.into())).await.map_err(|_| "relay response failed".to_owned())?;
                    }
                    Message::Ping(payload) => socket.send(Message::Pong(payload)).await.map_err(|_| "relay ping response failed".to_owned())?,
                    Message::Close(_) => return Err("relay closed the connection".to_owned()),
                    Message::Binary(_) => return Err("unexpected binary relay message".to_owned()),
                    Message::Pong(_) => {}
                    _ => {}
                }
            }
        }
    }
}

fn handle_request(store: &JobStore, uid: &str, message: &Value) -> Value {
    let message_id = message.get("messageId").and_then(Value::as_str);
    let reply_to = message_id.map(str::to_owned);
    if message.get("version").and_then(Value::as_u64) != Some(1)
        || message.get("uid").and_then(Value::as_str) != Some(uid)
    {
        return error_reply(reply_to, "invalid_payload", "Unsupported protocol version or account.", false);
    }
    let client_id = match message.get("clientId").and_then(Value::as_str) {
        Some(value) if Uuid::parse_str(value).is_ok() => value,
        _ => return error_reply(reply_to, "invalid_payload", "Client identity is invalid.", false),
    };
    let Some(message_id) = message_id.filter(|value| Uuid::parse_str(value).is_ok()) else {
        return error_reply(reply_to, "invalid_payload", "Message identity is invalid.", false);
    };

    match message.get("type").and_then(Value::as_str) {
        Some("job.submit") => submit_job(store, uid, client_id, message_id, message),
        Some("job.status") => job_status(store, uid, client_id, message_id, message),
        Some("job.list") => list_jobs(store, uid, client_id, message_id, message),
        Some("job.cancel") => cancel_job(store, uid, client_id, message_id, message),
        Some("job.retry") => error_reply(Some(message_id.to_owned()), "operation_unavailable", "Manual retry is not implemented yet.", false),
        Some("asset.list" | "asset.get") => error_reply(Some(message_id.to_owned()), "artifact_unavailable", "Asset metadata is not implemented yet.", false),
        _ => error_reply(Some(message_id.to_owned()), "invalid_payload", "Unsupported client request.", false),
    }
}

fn submit_job(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let request_id = message.get("requestId").and_then(Value::as_str);
    if !request_id.is_some_and(|value| Uuid::parse_str(value).is_ok()) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "requestId must be a UUID.", false);
    }
    let payload_version = message.get("payloadVersion").and_then(Value::as_u64).unwrap_or(1);
    if payload_version != 1 {
        return error_reply(Some(message_id.to_owned()), "unsupported_version", "Unsupported payload version.", false);
    }
    let Some(operation) = message.pointer("/payload/operation").and_then(Value::as_str) else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "An operation is required.", false);
    };
    let Some(params) = message.pointer("/payload/params").filter(|value| value.is_object()) else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Operation parameters must be an object.", false);
    };
    if operation != "narrative.generate" {
        return error_reply(Some(message_id.to_owned()), "operation_unavailable", "This server does not support the requested operation.", false);
    }
    if payload_version != 1 || !valid_narrative_payload(params) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Narration requires projectId, projectSha256, and a non-empty brief; metadata, when provided, must be an object.", false);
    }
    // Ignore future/unknown client fields and persist only the documented contract.
    let mut normalized_params = serde_json::Map::new();
    for key in ["projectId", "projectSha256", "brief"] {
        normalized_params.insert(key.to_owned(), params[key].clone());
    }
    if let Some(metadata) = params.get("metadata") {
        normalized_params.insert("metadata".to_owned(), metadata.clone());
    }
    let accepted = store.submit(SubmitRequest {
        uid: uid.to_owned(),
        client_id: client_id.to_owned(),
        request_id: request_id.unwrap().to_owned(),
        operation: operation.to_owned(),
        payload_version: payload_version as u32,
        payload: Value::Object(normalized_params),
    });
    match accepted {
        Ok(accepted) => json!({
            "version": 1,
            "type": "job.accepted",
            "messageId": Uuid::new_v4().to_string(),
            "replyTo": message_id,
            "requestId": request_id,
            "job": accepted
        }),
        Err(shadow_coordinator::StoreError::IdempotencyConflict) => error_reply(Some(message_id.to_owned()), "idempotency_conflict", "requestId was already used with a different payload.", false),
        Err(_) => error_reply(Some(message_id.to_owned()), "invalid_payload", "The job request was rejected.", false),
    }
}

fn valid_narrative_payload(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else { return false; };
    if !object.contains_key("projectId") || !object.contains_key("projectSha256") || !object.contains_key("brief") {
        return false;
    }
    let project_id = object.get("projectId").and_then(Value::as_str);
    let project_hash = object.get("projectSha256").and_then(Value::as_str);
    let brief = object.get("brief").and_then(Value::as_str);
    let metadata_valid = object.get("metadata").is_none_or(Value::is_object);
    project_id.is_some_and(|value| Uuid::parse_str(value).is_ok())
        && project_hash.is_some_and(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        && brief.is_some_and(|value| !value.trim().is_empty() && value.len() <= 12_000)
        && metadata_valid
}

fn job_status(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let job = if let Some(job_id) = message.get("jobId").and_then(Value::as_str) {
        if Uuid::parse_str(job_id).is_err() {
            return error_reply(Some(message_id.to_owned()), "invalid_payload", "jobId must be a UUID.", false);
        }
        match store.get(job_id) {
            Ok(Some(job)) if job.uid == uid && job.client_id == client_id => Some(job),
            Ok(_) => None,
            Err(_) => return error_reply(Some(message_id.to_owned()), "internal_error", "Could not read job status.", false),
        }
    } else if let Some(request_id) = message.get("requestId").and_then(Value::as_str) {
        if Uuid::parse_str(request_id).is_err() {
            return error_reply(Some(message_id.to_owned()), "invalid_payload", "requestId must be a UUID.", false);
        }
        match store.get_by_request(uid, client_id, request_id) {
            Ok(job) => job,
            Err(_) => return error_reply(Some(message_id.to_owned()), "internal_error", "Could not read job status.", false),
        }
    } else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Provide jobId or requestId.", false);
    };
    json!({ "version": 1, "type": "job.status", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "job": job })
}

fn list_jobs(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let limit = message.get("limit").and_then(Value::as_u64).unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Job limit must be between 1 and 100.", false);
    }
    match store.list(uid, client_id, limit as u32) {
        Ok(jobs) => json!({ "version": 1, "type": "job.list", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "jobs": jobs }),
        Err(_) => error_reply(Some(message_id.to_owned()), "internal_error", "Could not list jobs.", false),
    }
}

fn cancel_job(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let Some(job_id) = message.get("jobId").and_then(Value::as_str) else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "jobId is required.", false);
    };
    if Uuid::parse_str(job_id).is_err() {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "jobId must be a UUID.", false);
    }
    let job = match store.get(job_id) {
        Ok(Some(job)) if job.uid == uid && job.client_id == client_id => job,
        Ok(_) => return error_reply(Some(message_id.to_owned()), "job_not_found", "Job was not found.", false),
        Err(_) => return error_reply(Some(message_id.to_owned()), "internal_error", "Could not read job status.", false),
    };
    let next = match job.state {
        JobState::Queued => JobState::Cancelled,
        JobState::Running => JobState::CancelRequested,
        JobState::CancelRequested => return json!({ "version": 1, "type": "job.cancel.accepted", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "job": job }),
        _ => return error_reply(Some(message_id.to_owned()), "job_not_cancellable", "Job is already complete.", false),
    };
    match store.transition(job_id, next, None, "Cancellation requested by the authorized client") {
        Ok(job) => json!({ "version": 1, "type": "job.cancel.accepted", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "job": job }),
        Err(_) => error_reply(Some(message_id.to_owned()), "job_not_cancellable", "Job could not be cancelled in its current state.", false),
    }
}

fn error_reply(reply_to: Option<String>, code: &str, message: &str, retryable: bool) -> Value {
    json!({
        "version": 1,
        "type": "error",
        "messageId": Uuid::new_v4().to_string(),
        "replyTo": reply_to,
        "error": { "code": code, "message": message, "retryable": retryable }
    })
}

async fn wait_or_stop(stop: &AtomicBool, duration: Duration) {
    let deadline = tokio::time::Instant::now() + duration;
    while !stop.load(Ordering::Acquire) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn wait_until_stopped(stop: &AtomicBool) {
    while !stop.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn append_log(data_dir: &PathBuf, message: &str) {
    use std::{fs::{self, OpenOptions}, io::Write};
    if fs::create_dir_all(data_dir).is_err() {
        return;
    }
    let Ok(mut log) = OpenOptions::new().create(true).append(true).open(data_dir.join("coordinator.log")) else {
        return;
    };
    let _ = writeln!(log, "{:?} {message}", std::time::SystemTime::now());
}
