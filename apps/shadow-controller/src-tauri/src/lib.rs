#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(CoordinatorState::default())
        .invoke_handler(tauri::generate_handler![
            get_local_status,
            submit_local_job,
            get_local_job,
            list_local_jobs,
            cancel_local_job
        ])
        .setup(|app| {
            let state = app.state::<CoordinatorState>();
            store(&state, app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use shadow_coordinator::{AcceptedJob, JobRecord, JobState, JobStore, StoreError, SubmitRequest};
use tauri::Manager;

#[derive(Default)]
struct CoordinatorState {
    store: Mutex<Option<Arc<JobStore>>>,
    database_path: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStatus {
    application_version: String,
    coordinator: &'static str,
    database: &'static str,
    database_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewJob {
    client_id: String,
    request_id: String,
    operation: String,
    payload_version: u32,
    payload: serde_json::Value,
}

fn store(state: &CoordinatorState, app: &tauri::AppHandle) -> Result<Arc<JobStore>, String> {
    let mut slot = state.store.lock().map_err(|_| "Coordinator state unavailable".to_owned())?;
    if let Some(store) = slot.as_ref() {
        return Ok(Arc::clone(store));
    }

    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let database_path = data_dir.join("coordinator.sqlite3");
    let job_store = Arc::new(JobStore::open(&database_path).map_err(display_store_error)?);
    job_store
        .mark_running_jobs_interrupted()
        .map_err(display_store_error)?;
    *state
        .database_path
        .lock()
        .map_err(|_| "Coordinator state unavailable".to_owned())? = Some(database_path);
    *slot = Some(Arc::clone(&job_store));
    Ok(job_store)
}

#[tauri::command]
fn get_local_status(state: tauri::State<'_, CoordinatorState>) -> Result<LocalStatus, String> {
    let database_path = state
        .database_path
        .lock()
        .map_err(|_| "Coordinator state unavailable".to_owned())?
        .as_ref()
        .map(|path| path.display().to_string());
    Ok(LocalStatus {
        application_version: env!("CARGO_PKG_VERSION").to_owned(),
        coordinator: "local_only",
        database: if database_path.is_some() { "ready" } else { "not_initialized" },
        database_path,
    })
}

#[tauri::command]
fn submit_local_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoordinatorState>,
    job: NewJob,
) -> Result<AcceptedJob, String> {
    let store = store(&state, &app)?;
    store
        .submit(SubmitRequest {
            uid: "local-user".to_owned(),
            client_id: job.client_id,
            request_id: job.request_id,
            operation: job.operation,
            payload_version: job.payload_version,
            payload: job.payload,
        })
        .map_err(display_store_error)
}

#[tauri::command]
fn get_local_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoordinatorState>,
    job_id: String,
) -> Result<Option<JobRecord>, String> {
    store(&state, &app)?
        .get(&job_id)
        .map_err(display_store_error)
}

#[tauri::command]
fn list_local_jobs(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoordinatorState>,
    client_id: String,
    limit: u32,
) -> Result<Vec<JobRecord>, String> {
    store(&state, &app)?
        .list("local-user", &client_id, limit)
        .map_err(display_store_error)
}

#[tauri::command]
fn cancel_local_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoordinatorState>,
    job_id: String,
) -> Result<JobRecord, String> {
    let store = store(&state, &app)?;
    let job = store
        .get(&job_id)
        .map_err(display_store_error)?
        .ok_or_else(|| "job_not_found".to_owned())?;
    let (next, message) = match job.state {
        JobState::Queued => (JobState::Cancelled, "Cancelled before start"),
        JobState::Running => (JobState::CancelRequested, "Cancellation requested"),
        JobState::CancelRequested => return Ok(job),
        _ => return Ok(job),
    };
    store
        .transition(&job_id, next, None, message)
        .map_err(display_store_error)
}

fn display_store_error(error: StoreError) -> String {
    error.to_string()
}

