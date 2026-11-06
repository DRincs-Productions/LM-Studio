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
        Some("job.retry") => retry_job(store, uid, client_id, message_id, message),
        Some("asset.list") => list_assets(store, uid, client_id, message_id, message),
        Some("asset.get") => get_asset(store, uid, client_id, message_id, message),
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
        if operation == "codex.execute" {
            return submit_codex_job(store, uid, client_id, message_id, request_id.unwrap(), payload_version as u32, params);
        }
        return error_reply(Some(message_id.to_owned()), "operation_unavailable", "This server does not support the requested operation.", false);
    }
    if payload_version != 1 || !valid_narrative_payload(params) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Narration requires projectId, projectSha256, and a non-empty brief; metadata, when provided, must be an object.", false);
    }
    let mut sanitized = serde_json::Map::new();
    for key in ["projectId", "projectSha256", "brief", "metadata"] {
        if let Some(value) = params.get(key) {
            sanitized.insert(key.to_owned(), value.clone());
        }
    }
    let sanitized_payload = Value::Object(sanitized);
    if serde_json::to_vec(&sanitized_payload).is_ok_and(|encoded| encoded.len() > 48 * 1024) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Narration fields exceed the supported size limit.", false);
    }
    match store.submit(SubmitRequest {
        uid: uid.to_owned(),
        client_id: client_id.to_owned(),
        request_id: request_id.unwrap().to_owned(),
        operation: "narrative.generate".to_owned(),
        payload_version: 1,
        payload: sanitized_payload,
        retry_of_job_id: None,
    }) {
        Ok(accepted) => json!({
            "version": 1,
            "type": "job.accepted",
            "messageId": Uuid::new_v4().to_string(),
            "replyTo": message_id,
            "requestId": request_id,
            "job": accepted
        }),
        Err(shadow_coordinator::StoreError::IdempotencyConflict) => error_reply(Some(message_id.to_owned()), "idempotency_conflict", "requestId was already used with a different payload.", false),
        Err(_) => error_reply(Some(message_id.to_owned()), "invalid_payload", "The narration request was rejected.", false),
    }
}

fn submit_codex_job(
    store: &JobStore,
    uid: &str,
    client_id: &str,
    message_id: &str,
    request_id: &str,
    payload_version: u32,
    params: &Value,
) -> Value {
    if payload_version != 1 || !valid_codex_payload(params) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "codex.execute v1 requires exactly one non-empty task string of at most 12,000 characters.", false);
    }
    match store.submit(SubmitRequest {
        uid: uid.to_owned(),
        client_id: client_id.to_owned(),
        request_id: request_id.to_owned(),
        operation: "codex.execute".to_owned(),
        payload_version,
        payload: params.clone(),
        retry_of_job_id: None,
    }) {
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

fn valid_codex_payload(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else { return false; };
    if object.len() != 1 || !object.contains_key("task") { return false; }
    object.get("task").and_then(Value::as_str)
        .is_some_and(|task| !task.trim().is_empty() && task.chars().count() <= 12_000)
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

fn retry_job(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let Some(job_id) = message.get("jobId").and_then(Value::as_str) else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "jobId is required.", false);
    };
    if Uuid::parse_str(job_id).is_err() {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "jobId must be a UUID.", false);
    }
    let Some(retry_request_id) = message.get("retryRequestId").and_then(Value::as_str) else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "retryRequestId is required.", false);
    };
    if Uuid::parse_str(retry_request_id).is_err() {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "retryRequestId must be a UUID.", false);
    }
    match store.retry_failed(uid, client_id, job_id, retry_request_id) {
        Ok(accepted) => json!({
            "version": 1,
            "type": "job.retry.accepted",
            "messageId": Uuid::new_v4().to_string(),
            "replyTo": message_id,
            "requestId": retry_request_id,
            "job": accepted.job,
            "duplicate": accepted.duplicate
        }),
        Err(shadow_coordinator::StoreError::JobNotFound) => error_reply(Some(message_id.to_owned()), "job_not_found", "Job was not found.", false),
        Err(shadow_coordinator::StoreError::InvalidRequest(_)) => error_reply(Some(message_id.to_owned()), "job_not_cancellable", "Only failed jobs can be manually retried.", false),
        Err(shadow_coordinator::StoreError::IdempotencyConflict) => error_reply(Some(message_id.to_owned()), "idempotency_conflict", "retryRequestId was already used for a different request.", false),
        Err(_) => error_reply(Some(message_id.to_owned()), "internal_error", "Could not create the manual retry.", false),
    }
}

fn list_assets(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let limit = message.get("limit").and_then(Value::as_u64).unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "Asset limit must be between 1 and 100.", false);
    }
    let jobs = if let Some(job_id) = message.get("jobId").and_then(Value::as_str) {
        if Uuid::parse_str(job_id).is_err() {
            return error_reply(Some(message_id.to_owned()), "invalid_payload", "jobId must be a UUID.", false);
        }
        match store.get(job_id) {
            Ok(Some(job)) if job.uid == uid && job.client_id == client_id => vec![job],
            Ok(_) => return json!({ "version": 1, "type": "asset.list", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "assets": [] }),
            Err(_) => return error_reply(Some(message_id.to_owned()), "internal_error", "Could not list assets.", false),
        }
    } else {
        match store.list(uid, client_id, limit as u32) {
            Ok(jobs) => jobs,
            Err(_) => return error_reply(Some(message_id.to_owned()), "internal_error", "Could not list assets.", false),
        }
    };
    let assets = jobs.iter().filter_map(narrative_asset).collect::<Vec<_>>();
    json!({ "version": 1, "type": "asset.list", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "assets": assets })
}

fn get_asset(store: &JobStore, uid: &str, client_id: &str, message_id: &str, message: &Value) -> Value {
    let Some(asset_id) = message.get("assetId").and_then(Value::as_str) else {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "assetId is required.", false);
    };
    let Some(job_id) = asset_id.strip_prefix("narrative:") else {
        return error_reply(Some(message_id.to_owned()), "artifact_unavailable", "Asset was not found.", false);
    };
    if Uuid::parse_str(job_id).is_err() {
        return error_reply(Some(message_id.to_owned()), "invalid_payload", "assetId is invalid.", false);
    }
    match store.get(job_id) {
        Ok(Some(job)) if job.uid == uid && job.client_id == client_id => match narrative_asset(&job) {
            Some(asset) => json!({ "version": 1, "type": "asset.available", "messageId": Uuid::new_v4().to_string(), "replyTo": message_id, "asset": asset }),
            None => error_reply(Some(message_id.to_owned()), "artifact_unavailable", "No verified narrative artifact is available for this job.", false),
        },
        Ok(_) => error_reply(Some(message_id.to_owned()), "artifact_unavailable", "Asset was not found.", false),
        Err(_) => error_reply(Some(message_id.to_owned()), "internal_error", "Could not read asset metadata.", false),
    }
}

fn narrative_asset(job: &shadow_coordinator::JobRecord) -> Option<Value> {
    let manifest = job.result_manifest.as_ref()?;
    let remote_path = manifest.get("narrativeRemotePath")?.as_str()?;
    let expected_path = format!("imagecloud:NarrationWorker/final/{}/scene.md", job.job_id);
    if remote_path != expected_path {
        return None;
    }
    let sha256 = manifest.get("narrativeSha256")?.as_str()?;
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return None;
    }
    let bytes = manifest.get("stages")?.as_array()?.iter().find_map(|stage| {
        (stage.get("stage")?.as_str()? == "onedrive" && stage.get("outcome")?.as_str()? == "verified")
            .then(|| stage.get("bytes")?.as_u64())
            .flatten()
    })?;
    Some(json!({
        "assetId": format!("narrative:{}", job.job_id),
        "jobId": job.job_id,
        "kind": "narrative",
        "name": "scene.md",
        "remotePath": remote_path,
        "sha256": sha256,
        "sizeBytes": bytes,
        "downloadTool": "get_narration_result"
    }))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn completed_job(remote_path: String, sha256: &str) -> shadow_coordinator::JobRecord {
        shadow_coordinator::JobRecord {
            job_id: "148a32da-6c82-4b0e-a1c3-a567070d5511".into(),
            uid: "user-1".into(),
            client_id: "client-1".into(),
            request_id: "request-1".into(),
            state: JobState::Succeeded,
            fifo_sequence: 1,
            engine: Some("narration".into()),
            created_at: "2026-11-06T00:00:00Z".into(),
            started_at: Some("2026-11-06T00:00:01Z".into()),
            finished_at: Some("2026-11-06T00:00:02Z".into()),
            timeout_at: None,
            error_code: None,
            result_manifest: Some(json!({
                "narrativeRemotePath": remote_path,
                "narrativeSha256": sha256,
                "stages": [{ "stage": "onedrive", "outcome": "verified", "bytes": 321 }]
            })),
            retry_of_job_id: None,
        }
    }

    #[test]
    fn asset_metadata_requires_the_canonical_path_and_verified_hash() {
        let job_id = "148a32da-6c82-4b0e-a1c3-a567070d5511";
        let path = format!("imagecloud:NarrationWorker/final/{job_id}/scene.md");
        let asset = narrative_asset(&completed_job(path.clone(), &"a".repeat(64))).unwrap();
        assert_eq!(asset["assetId"], format!("narrative:{job_id}"));
        assert_eq!(asset["remotePath"], path);
        assert_eq!(asset["sha256"], "a".repeat(64));
        assert_eq!(asset["sizeBytes"], 321);

        assert!(narrative_asset(&completed_job("imagecloud:other/scene.md".into(), &"a".repeat(64))).is_none());
        assert!(narrative_asset(&completed_job(path, &"A".repeat(64))).is_none());
    }
}
