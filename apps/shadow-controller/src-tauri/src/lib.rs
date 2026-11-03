#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod auth;

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod auth {
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AuthIdentity {
        uid: String,
        email: String,
    }

    pub fn begin_login() -> Result<String, String> {
        Err("Google sign-in is not supported on this platform yet".to_owned())
    }

    pub fn identity() -> Result<Option<AuthIdentity>, String> {
        Ok(None)
    }

    pub fn id_token() -> Result<String, String> {
        Err("Google sign-in is not supported on this platform yet".to_owned())
    }

    pub fn sign_out() -> Result<(), String> {
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    builder
        .manage(CoordinatorState::default())
        .invoke_handler(tauri::generate_handler![
            get_local_status,
            submit_local_job,
            get_local_job,
            list_local_jobs,
            list_local_job_events,
            cancel_local_job,
            stop_local_coordinator,
            start_local_coordinator,
            begin_local_auth,
            get_local_auth_status,
            get_firebase_id_token,
            sign_out_local_auth
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(std::io::Error::other)?;
            let expected_data_dir = shadow_coordinator::runtime::default_data_dir()?;
            if data_dir != expected_data_dir {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Tauri and Coordinator data directories do not match",
                )
                .into());
            }
            let state = app.state::<CoordinatorState>();
            store(&state, app.handle()).map_err(std::io::Error::other)?;

            #[cfg(windows)]
            {
                use tauri_plugin_autostart::ManagerExt;
                app.handle()
                    .plugin(tauri_plugin_autostart::init(
                        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                        Some(vec!["--coordinator"]),
                    ))?;
                if !cfg!(debug_assertions) {
                    if let Err(error) = app.autolaunch().enable() {
                        append_coordinator_log(&data_dir, &format!("Could not register autostart: {error}"));
                    }
                }
                if let Err(error) = ensure_coordinator_started(&data_dir) {
                    append_coordinator_log(&data_dir, &format!("Could not start Coordinator: {error}"));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use shadow_coordinator::{
    AcceptedJob, JobEvent, JobRecord, JobState, JobStore, StoreError, SubmitRequest,
};
use tauri::Manager;

pub fn run_coordinator_from_environment() -> Result<(), shadow_coordinator::runtime::RuntimeError> {
    let data_dir = shadow_coordinator::runtime::default_data_dir()?;
    append_coordinator_log(&data_dir, "Background Coordinator starting");
    let result = shadow_coordinator::runtime::run_service(&data_dir);
    match &result {
        Ok(()) => append_coordinator_log(&data_dir, "Background Coordinator stopped"),
        Err(error) => append_coordinator_log(&data_dir, &format!("Background Coordinator failed: {error}")),
    }
    result
}

fn append_coordinator_log(data_dir: &Path, message: &str) {
    if fs::create_dir_all(data_dir).is_err() {
        return;
    }
    let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("coordinator.log"))
    else {
        return;
    };
    let _ = writeln!(log, "{:?} {message}", SystemTime::now());
}

fn ensure_coordinator_started(data_dir: &Path) -> Result<(), String> {
    if shadow_coordinator::runtime::is_running(data_dir).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg("--coordinator")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

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
    let coordinator = match state
        .database_path
        .lock()
        .map_err(|_| "Coordinator state unavailable".to_owned())?
        .as_ref()
    {
        Some(path) => {
            let data_dir = path.parent().ok_or("Coordinator data path is invalid")?;
            if shadow_coordinator::runtime::is_running(data_dir).map_err(|error| error.to_string())? {
                "running"
            } else {
                "stopped"
            }
        }
        None => "stopped",
    };
    Ok(LocalStatus {
        application_version: env!("CARGO_PKG_VERSION").to_owned(),
        coordinator,
        database: if database_path.is_some() { "ready" } else { "not_initialized" },
        database_path,
    })
}

#[tauri::command]
fn stop_local_coordinator(app: tauri::AppHandle) -> Result<bool, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    shadow_coordinator::runtime::request_stop(&data_dir).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_local_coordinator(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    ensure_coordinator_started(&data_dir)
}

#[tauri::command]
fn begin_local_auth() -> Result<String, String> {
    auth::begin_login()
}

#[tauri::command]
fn get_local_auth_status() -> Result<Option<auth::AuthIdentity>, String> {
    auth::identity()
}

#[tauri::command]
fn get_firebase_id_token() -> Result<String, String> {
    auth::id_token()
}

#[tauri::command]
fn sign_out_local_auth() -> Result<(), String> {
    auth::sign_out()
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
fn list_local_job_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoordinatorState>,
    client_id: String,
    job_id: String,
    limit: u32,
) -> Result<Vec<JobEvent>, String> {
    store(&state, &app)?
        .list_events("local-user", &client_id, &job_id, limit)
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

