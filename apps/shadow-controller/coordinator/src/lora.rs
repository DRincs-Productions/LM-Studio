use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{JobStore, StoreError, timestamp};

#[path = "lora_character.rs"]
mod character;

const STATUS_FIELDS: &str = "id, attached_at, paused, state, detail";

impl JobStore {
    pub fn lora_request(
        &self,
        data: &Path,
        uid: &str,
        client: &str,
        action: &str,
        message: &Value,
    ) -> Result<Value, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        if action.starts_with("character_") {
            return character::request(&connection, data, uid, client, action, message);
        }
        if action == "list" {
            let mut query = connection.prepare(&format!(
                "SELECT {STATUS_FIELDS} FROM lora_jobs WHERE uid=?1 AND client_id=?2 ORDER BY rowid DESC LIMIT 50"
            ))?;
            let rows = query.query_map(params![uid, client], lora_status)?;
            return Ok(json!({"jobs": rows.collect::<Result<Vec<_>, _>>()?}));
        }
        let id = if action == "import" {
            let request = uuid_field(message, "requestId")?;
            let name = message["fileName"]
                .as_str()
                .filter(|name| {
                    name.ends_with(".json")
                        && name.len() <= 120
                        && name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
                })
                .ok_or(StoreError::InvalidRequest(
                    "Use the name of a JSON export in the server lora-inbox",
                ))?;
            let existing: Option<(String, String)> = connection.query_row(
                "SELECT id,file_name FROM lora_jobs WHERE uid=?1 AND client_id=?2 AND request_id=?3",
                params![uid, client, request], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if let Some((id, original_name)) = existing {
                if original_name != name {
                    return Err(StoreError::IdempotencyConflict);
                }
                id
            } else {
                let inbox = data
                    .join("lora-inbox")
                    .canonicalize()
                    .map_err(|_| StoreError::InvalidRequest("Server lora-inbox is unavailable"))?;
                let path = inbox
                    .join(name)
                    .canonicalize()
                    .ok()
                    .filter(|path| path.parent() == Some(inbox.as_path()) && path.is_file())
                    .ok_or(StoreError::InvalidRequest(
                        "OneTrainer export was not found in the server inbox",
                    ))?;
                let mut serialized = String::new();
                File::open(path)
                    .and_then(|file| file.take(1024 * 1024 + 1).read_to_string(&mut serialized))
                    .map_err(|_| StoreError::InvalidRequest("Cannot read OneTrainer export"))?;
                if serialized.len() > 1024 * 1024 {
                    return Err(StoreError::InvalidRequest(
                        "OneTrainer export exceeds 1 MiB",
                    ));
                }
                let config = validate_export_text(&serialized)?;
                let id = Uuid::new_v4().to_string();
                connection.execute(
                    "INSERT INTO lora_jobs(id,uid,client_id,request_id,file_name,config) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![id, uid, client, request, name, config.to_string()],
                )?;
                id
            }
        } else {
            uuid_field(message, "jobId")?
        };
        let filter = "WHERE id=?1 AND uid=?2 AND client_id=?3";
        let update = match action {
            "attach" => Some("attached_at=COALESCE(attached_at,?4)"),
            "detach" => Some("attached_at=NULL"),
            "pause" => Some("paused=1"),
            "start" | "resume" => Some(
                "paused=0, state=CASE WHEN state='failed' THEN 'waiting' ELSE state END, detail=CASE WHEN state='failed' THEN NULL ELSE detail END",
            ),
            "status" | "import" => None,
            _ => return Err(StoreError::InvalidRequest("Unknown LoRA action")),
        };
        if let Some(update) = update {
            let mut condition = format!("{filter} AND state NOT IN ('completed','draft')");
            if matches!(action, "start" | "resume") {
                condition.push_str(" AND attached_at IS NOT NULL");
            }
            let sql = format!("UPDATE lora_jobs SET {update} {condition}");
            let changed = if action == "attach" {
                connection.execute(&sql, params![id, uid, client, timestamp()])?
            } else {
                connection.execute(&sql, params![id, uid, client])?
            };
            if changed == 0 && matches!(action, "start" | "resume") {
                return Err(StoreError::InvalidRequest(
                    "Start or resume requires an attached, incomplete job",
                ));
            }
        }
        let job = connection
            .query_row(
                &format!("SELECT {STATUS_FIELDS} FROM lora_jobs {filter}"),
                params![id, uid, client],
                lora_status,
            )
            .optional()?
            .ok_or(StoreError::JobNotFound)?;
        let mut job = job;
        if action == "status" {
            let config: Option<String> = connection
                .query_row(
                    "SELECT config FROM lora_jobs WHERE id=?1 AND file_name='character'",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(config) = config {
                let config: Value = serde_json::from_str(&config)?;
                let images = config["images"].as_object().unwrap();
                if message["imageId"].is_string() {
                    let key = uuid_field(message, "imageId")?;
                    job["image"] = images.get(&key).cloned().ok_or(StoreError::JobNotFound)?;
                    if job["image"]["state"] == "ready" {
                        let camera_path = data
                            .join("lora")
                            .join(&id)
                            .join("samples")
                            .join(&key)
                            .join(format!("{key}.camera.json"));
                        if let Ok(camera) = fs::read_to_string(camera_path) {
                            job["image"]["camera"] = serde_json::from_str(&camera)?;
                        }
                    }
                } else {
                    job["images"] = json!(
                        images
                            .iter()
                            .map(|(key, value)| json!({"imageId":key,"state":value["state"]}))
                            .collect::<Vec<_>>()
                    );
                }
            }
        }
        Ok(json!({"job": job}))
    }

    pub(crate) fn recover_lora(&self, data: &Path) -> Result<(), StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?;
        connection.execute("UPDATE lora_jobs SET config=(SELECT json_set(lora_jobs.config,'$.images',
            json_group_object(key,json(CASE WHEN json_extract(value,'$.state')='preparing'
                THEN json_set(value,'$.state','pending') ELSE value END))) FROM json_each(lora_jobs.config,'$.images'))
            WHERE file_name='character'", [])?;
        let mut query = connection
            .prepare("SELECT id,config FROM lora_jobs WHERE state IN ('running','pausing')")?;
        let ids = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, config) in ids {
            let config: Value = serde_json::from_str(&config)?;
            let output = training_workspace(data, &id, config["revision"].as_u64().unwrap_or(0))
                .join("model.safetensors");
            let (state, detail) = if output.is_file() {
                ("completed", output.display().to_string())
            } else {
                (
                    "waiting",
                    "Interrupted. Will recover from the latest verified checkpoint.".to_owned(),
                )
            };
            connection.execute(
                "UPDATE lora_jobs SET state=?2,detail=?3 WHERE id=?1",
                params![id, state, detail],
            )?;
        }
        Ok(())
    }
}

fn validate_export_text(serialized: &str) -> Result<Value, StoreError> {
    let config: Value = serde_json::from_str(serialized.trim_start_matches('\u{feff}'))?;
    if config["training_method"] != "LORA"
        || !config["concepts"].as_array().is_some_and(|concepts| {
            !concepts.is_empty()
                && concepts
                    .iter()
                    .any(|concept| concept["enabled"].as_bool() == Some(true))
        })
    {
        return Err(StoreError::InvalidRequest(
            "Export a LoRA configuration with enabled concepts",
        ));
    }
    Ok(config)
}

fn uuid_field(message: &Value, field: &str) -> Result<String, StoreError> {
    message[field]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .map(|id| id.to_string())
        .ok_or(StoreError::InvalidRequest("A valid UUID is required"))
}

fn lora_status(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "jobId": row.get::<_, String>(0)?,
        "attached": row.get::<_, Option<String>>(1)?.is_some(),
        "paused": row.get::<_, bool>(2)?,
        "state": row.get::<_, String>(3)?,
        "detail": row.get::<_, Option<String>>(4)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lora_import_is_detached_idempotent_and_scoped_to_the_owner() {
        let root = std::env::temp_dir().join(format!("shadow-lora-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("lora-inbox")).unwrap();
        fs::write(
            root.join("lora-inbox/test.json"),
            r#"{"training_method":"LORA","concepts":[{"enabled":true}]}"#,
        )
        .unwrap();
        let store = JobStore::open_in_memory().unwrap();
        let request = json!({"fileName":"test.json", "requestId":Uuid::new_v4()});
        let job = store
            .lora_request(&root, "uid", "owner", "import", &request)
            .unwrap();
        assert_eq!(job["job"]["attached"], false);
        assert_eq!(
            store
                .lora_request(&root, "uid", "owner", "import", &request)
                .unwrap(),
            job
        );
        let key = json!({"jobId":job["job"]["jobId"]});
        assert!(
            store
                .lora_request(&root, "uid", "other", "attach", &key)
                .is_err()
        );
        let attached = store
            .lora_request(&root, "uid", "owner", "attach", &key)
            .unwrap();
        assert_eq!(attached["job"]["attached"], true);
        set_state(
            &store,
            key["jobId"].as_str().unwrap(),
            "running",
            "Training",
        )
        .unwrap();
        assert_eq!(
            store
                .lora_request(&root, "uid", "owner", "pause", &key)
                .unwrap()["job"]["paused"],
            true
        );
        assert_eq!(
            store
                .lora_request(&root, "uid", "owner", "detach", &key)
                .unwrap()["job"]["attached"],
            false
        );
        fs::remove_file(root.join("lora-inbox/test.json")).unwrap();
        fs::remove_dir(root.join("lora-inbox")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}

#[derive(Default)]
pub(crate) struct Scheduler {
    active: Option<Attempt>,
    next_probe: Option<Instant>,
    preparation: Option<(Attempt, String)>,
    last_upload_cleanup: Option<Instant>,
}

struct Attempt {
    id: String,
    path: PathBuf,
    worker: Child,
    deadline: Option<Instant>,
    #[cfg(windows)]
    _job: windows_job::Job,
}

impl Scheduler {
    pub(crate) fn tick(
        &mut self,
        data: &Path,
        store: &JobStore,
        foreground: bool,
        stopping: bool,
    ) -> Result<bool, crate::runtime::RuntimeError> {
        #[cfg(windows)]
        if let Some((attempt, sample)) = &mut self.preparation {
            if let Some(status) = attempt.worker.try_wait()? {
                let caption = status
                    .success()
                    .then(|| fs::read_to_string(attempt.path.join("caption.txt")).ok())
                    .flatten();
                let (state, detail) = if let Some(caption) = caption.as_deref() {
                    ("ready", Some(caption))
                } else if status.code() == Some(75) {
                    ("pending", None)
                } else {
                    (
                        "failed",
                        Some("Image preparation failed. See the server preparation log."),
                    )
                };
                character::preparation_state(store, &attempt.id, sample, state, detail)?;
                self.preparation = None;
            } else {
                if foreground || stopping {
                    attempt._job.terminate()?;
                }
                return Ok(true);
            }
        }
        if let Some(attempt) = &mut self.active {
            if let Some(status) = attempt.worker.try_wait()? {
                let output = attempt.path.parent().unwrap().join("model.safetensors");
                let (state, detail) = if output.is_file() {
                    ("completed", output.display().to_string())
                } else if status.code() == Some(75) {
                    (
                        "waiting",
                        format!("Paused. Attempt log: {}", attempt.path.display()),
                    )
                } else {
                    (
                        "failed",
                        format!(
                            "Training exited with {status}. Attempt log: {}",
                            attempt.path.display()
                        ),
                    )
                };
                set_state(store, &attempt.id, state, &detail)?;
                self.active = None;
                return Ok(false);
            }
            let eligible: bool = store
                .connection
                .lock()
                .map_err(|_| StoreError::LockPoisoned)?
                .query_row(
                    "SELECT attached_at IS NOT NULL AND paused=0 FROM lora_jobs WHERE id=?1",
                    [&attempt.id],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)?;
            if let Some(deadline) = attempt.deadline {
                if Instant::now() >= deadline {
                    #[cfg(windows)]
                    attempt._job.terminate()?;
                    #[cfg(not(windows))]
                    attempt.worker.kill()?;
                }
            } else {
                let pressure = !foreground
                    && !stopping
                    && eligible
                    && probe_due(&mut self.next_probe)
                    && !resources_available(data, false);
                if foreground || stopping || !eligible || pressure {
                    fs::write(attempt.path.join("pause"), [])?;
                    attempt.deadline = Some(Instant::now() + Duration::from_secs(60));
                    set_state(
                        store,
                        &attempt.id,
                        "pausing",
                        "Saving training progress and releasing resources",
                    )?;
                }
            }
            return Ok(true);
        }
        if foreground || stopping || !cfg!(windows) {
            return Ok(false);
        }
        if self
            .last_upload_cleanup
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(300))
        {
            character::expire_uploads(store, data)?;
            self.last_upload_cleanup = Some(Instant::now());
        }
        #[cfg(windows)]
        if let Some((id, sample, trigger, image)) = character::pending(store)? {
            if character::preparation_state(store, &id, &sample, "preparing", None)? {
                match launch_preparation(data, &id, &sample, &trigger, &image) {
                    Ok(attempt) => {
                        self.preparation = Some((attempt, sample));
                        return Ok(true);
                    }
                    Err(_) => {
                        character::preparation_state(
                            store,
                            &id,
                            &sample,
                            "failed",
                            Some("Cannot launch image preparation"),
                        )?;
                    }
                }
            }
        }
        let candidate: Option<(String, String)> = store.connection.lock().map_err(|_| StoreError::LockPoisoned)?
            .query_row("SELECT id,config FROM lora_jobs WHERE state='waiting' AND attached_at IS NOT NULL AND paused=0 ORDER BY attached_at,rowid LIMIT 1",
                [], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(StoreError::from)?;
        if let Some((id, config)) = candidate {
            if !probe_due(&mut self.next_probe) {
                return Ok(false);
            }
            if !resources_available(data, true) {
                set_state(
                    store,
                    &id,
                    "waiting",
                    "Waiting for RAM, VRAM, disk space or the local OneTrainer installation",
                )?;
                return Ok(false);
            }
            set_state(store, &id, "running", "Starting OneTrainer")?;
            match launch(data, &id, &config) {
                Ok(attempt) => self.active = Some(attempt),
                Err(error) => set_state(store, &id, "failed", &error.to_string())?,
            }
        }
        Ok(self.active.is_some())
    }
}

fn set_state(store: &JobStore, id: &str, state: &str, detail: &str) -> Result<(), StoreError> {
    store
        .connection
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?
        .execute(
            "UPDATE lora_jobs SET state=?2, detail=?3 WHERE id=?1",
            params![id, state, detail],
        )?;
    Ok(())
}

fn probe_due(next: &mut Option<Instant>) -> bool {
    let now = Instant::now();
    if next.is_some_and(|deadline| now < deadline) {
        return false;
    }
    *next = Some(now + Duration::from_secs(5));
    true
}

fn trainer_home() -> PathBuf {
    std::env::var_os("SHADOW_ONETRAINER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\AI\OneTrainer"))
}

fn python(home: &Path) -> Command {
    let mut command = Command::new(home.join("venv").join("Scripts").join("python.exe"));
    command.current_dir(home).env("PYTHONUTF8", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_4000); // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
    }
    command
}

fn resources_available(data: &Path, starting: bool) -> bool {
    const PROBE: &str = r#"
import os, psutil, shutil, subprocess, sys
starting = sys.argv[2] == "true"
memory = psutil.virtual_memory()
if memory.available < memory.total * (0.20 if starting else 0.10):
    sys.exit(1)
if shutil.disk_usage(sys.argv[1]).free < (20 if starting else 10) * 1024**3:
    sys.exit(1)
if starting:
    result = subprocess.check_output(
        ['nvidia-smi', '--id=0', '--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
        timeout=2, creationflags=0x08000000,
    )
    free, total = map(int, result.decode().strip().split(','))
    if free < total * 0.80:
        sys.exit(1)
"#;
    python(&trainer_home())
        .args(["-c", PROBE])
        .arg(data)
        .arg(starting.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn training_workspace(data: &Path, id: &str, revision: u64) -> PathBuf {
    let root = data.join("lora").join(id);
    if revision == 0 {
        root
    } else {
        root.join(format!("revision-{revision}"))
    }
}

#[cfg(windows)]
fn launch(data: &Path, id: &str, config: &str) -> io::Result<Attempt> {
    let data = data.canonicalize()?;
    let parsed: Value = serde_json::from_str(config)?;
    let workspace = training_workspace(&data, id, parsed["revision"].as_u64().unwrap_or(0));
    fs::create_dir_all(&workspace)?;
    let path = workspace.join(Uuid::new_v4().to_string());
    fs::create_dir(&path)?;
    let export = parsed.get("training").map(Value::to_string);
    fs::write(
        workspace.join("export.json"),
        export.as_deref().unwrap_or(config),
    )?;
    let runner = path.join("runner.py");
    fs::write(&runner, include_str!("lora_runner.py"))?;
    let log = File::create(path.join("training.log"))?;
    let job = windows_job::Job::new()?;
    let mut worker = python(&trainer_home())
        .arg("-u")
        .arg(runner)
        .arg(workspace)
        .arg(&path)
        .env("CUDA_VISIBLE_DEVICES", "0")
        .env(
            "SHADOW_LORA_PARENT_WORKSPACE",
            parsed["parentRevision"]
                .as_u64()
                .map(|revision| training_workspace(&data, id, revision))
                .unwrap_or_default(),
        )
        .env(
            "SHADOW_LORA_EPOCH_BACKUPS",
            if export.is_some() { "1" } else { "0" },
        )
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()?;
    if let Err(error) = job
        .assign(&worker)
        .and_then(|_| worker.stdin.take().unwrap().write_all(b"1"))
    {
        let _ = worker.kill();
        let _ = worker.wait();
        return Err(error);
    }
    Ok(Attempt {
        id: id.to_owned(),
        path,
        worker,
        deadline: None,
        _job: job,
    })
}

#[cfg(not(windows))]
fn launch(_: &Path, _: &str, _: &str) -> io::Result<Attempt> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "OneTrainer integration requires Windows",
    ))
}

#[cfg(windows)]
mod windows_job {
    use std::{io, os::windows::io::AsRawHandle, process::Child, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
    };

    pub struct Job(HANDLE);

    impl Job {
        pub fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            checked(unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            })?;
            Ok(job)
        }

        pub fn assign(&self, worker: &Child) -> io::Result<()> {
            checked(unsafe { AssignProcessToJobObject(self.0, worker.as_raw_handle()) })
        }

        pub fn terminate(&self) -> io::Result<()> {
            checked(unsafe { TerminateJobObject(self.0, 75) })
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn checked(result: i32) -> io::Result<()> {
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
fn launch_preparation(
    data: &Path,
    id: &str,
    sample: &str,
    trigger: &str,
    image: &Value,
) -> io::Result<Attempt> {
    use std::os::windows::process::CommandExt;

    let root = data
        .canonicalize()?
        .join("lora")
        .join(id)
        .join("samples")
        .join(sample);
    let path = root.join(Uuid::new_v4().to_string());
    fs::create_dir(&path)?;
    fs::write(
        path.join("request.json"),
        serde_json::to_vec(&json!({
            "root":root,"sample":sample,"trigger":trigger,"description":image["description"],
            "jobId":id,"batch":image["batch"],"sha256":image["sha256"],"size":image["size"]
        }))?,
    )?;
    fs::write(path.join("prepare.mjs"), include_str!("lora_prepare.mjs"))?;
    let log = File::create(path.join("preparation.log"))?;
    let job = windows_job::Job::new()?;
    let mut worker = python(&trainer_home());
    // Hold the launcher on stdin until it belongs to the job object.
    let mut worker = worker.current_dir(&path).args(["-c",
        "import subprocess,sys; sys.exit(subprocess.call(['node','prepare.mjs']) if sys.stdin.buffer.read(1)==b'1' else 74)"])
        .creation_flags(0x0800_4000)
        .stdin(Stdio::piped()).stdout(log.try_clone()?).stderr(log).spawn()?;
    if let Err(error) = job
        .assign(&worker)
        .and_then(|_| worker.stdin.take().unwrap().write_all(b"1"))
    {
        let _ = worker.kill();
        let _ = worker.wait();
        return Err(error);
    }
    Ok(Attempt {
        id: id.to_owned(),
        path,
        worker,
        deadline: None,
        _job: job,
    })
}
