use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use fs2::FileExt;
use thiserror::Error;
use uuid::Uuid;

use crate::{JobStore, StoreError};

const LOCK_FILE: &str = "coordinator.lock";
const PID_FILE: &str = "coordinator.pid";
const STOP_FILE: &str = "coordinator.stop";

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
}

struct CoordinatorLease {
    lock: File,
    data_dir: PathBuf,
    token: String,
}

impl CoordinatorLease {
    fn acquire(data_dir: &Path) -> Result<Option<Self>, RuntimeError> {
        fs::create_dir_all(data_dir)?;
        let lock = match OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data_dir.join(LOCK_FILE))
        {
            Ok(lock) => lock,
            Err(error) if is_lock_contention(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        match lock.try_lock_exclusive() {
            Ok(()) => {}
            Err(error) if is_lock_contention(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
        }

        let token = Uuid::new_v4().to_string();
        let _ = fs::remove_file(data_dir.join(STOP_FILE));
        fs::write(
            data_dir.join(PID_FILE),
            format!("{}\n{}\n", std::process::id(), token),
        )?;
        Ok(Some(Self {
            lock,
            data_dir: data_dir.to_path_buf(),
            token,
        }))
    }

    fn stop_requested(&self) -> Result<bool, RuntimeError> {
        match fs::read_to_string(self.data_dir.join(STOP_FILE)) {
            Ok(token) => Ok(token.trim() == self.token),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

impl Drop for CoordinatorLease {
    fn drop(&mut self) {
        let pid_path = self.data_dir.join(PID_FILE);
        if fs::read_to_string(&pid_path)
            .is_ok_and(|contents| contents.lines().nth(1) == Some(self.token.as_str()))
        {
            let _ = fs::remove_file(pid_path);
        }
        let stop_path = self.data_dir.join(STOP_FILE);
        if fs::read_to_string(&stop_path).is_ok_and(|contents| contents.trim() == self.token) {
            let _ = fs::remove_file(stop_path);
        }
        let _ = FileExt::unlock(&self.lock);
    }
}

pub fn is_running(data_dir: &Path) -> Result<bool, RuntimeError> {
    fs::create_dir_all(data_dir)?;
    let lock = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data_dir.join(LOCK_FILE))
    {
        Ok(lock) => lock,
        Err(error) if is_lock_contention(&error) => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    match lock.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&lock)?;
            Ok(false)
        }
        Err(error) if is_lock_contention(&error) => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn is_lock_contention(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock || error.raw_os_error() == Some(33)
}

pub fn request_stop(data_dir: &Path) -> Result<bool, RuntimeError> {
    let pid_file = match fs::read_to_string(data_dir.join(PID_FILE)) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let Some(token) = pid_file.lines().nth(1) else {
        return Ok(false);
    };
    if !is_running(data_dir)? {
        return Ok(false);
    }

    let mut stop_file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(data_dir.join(STOP_FILE))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(fs::read_to_string(data_dir.join(STOP_FILE))?.trim() == token);
        }
        Err(error) => return Err(error.into()),
    };
    stop_file.write_all(token.as_bytes())?;
    stop_file.sync_all()?;
    Ok(true)
}

/// Runs the persistent local Coordinator without opening the Tauri window.
/// The caller receives `Ok(())` when another instance already owns the lock or
/// when a controlled stop request is received.
pub fn run_service(data_dir: &Path) -> Result<(), RuntimeError> {
    let Some(lease) = CoordinatorLease::acquire(data_dir)? else {
        return Ok(());
    };
    let store = JobStore::open(data_dir.join("coordinator.sqlite3"))?;
    store.mark_running_jobs_interrupted()?;

    loop {
        if lease.stop_requested()? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
}

pub fn default_data_dir() -> Result<PathBuf, RuntimeError> {
    let identifier = "com.drincs.shadowcontroller";
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "APPDATA is unavailable"))?;

    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?
        .join("Library")
        .join("Application Support");

    #[cfg(target_os = "linux")]
    let base = match std::env::var_os("XDG_DATA_HOME") {
        Some(path) => PathBuf::from(path),
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?
            .join(".local")
            .join("share"),
    };

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let base = {
        let _ = identifier;
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Coordinator autostart is not supported on this platform",
        )
        .into());
    };

    Ok(base.join(identifier))
}

pub fn run_service_from_environment() -> Result<(), RuntimeError> {
    run_service(&default_data_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("shadow-coordinator-{}", Uuid::new_v4()))
    }

    #[test]
    fn instance_lock_and_controlled_stop_are_scoped_to_the_coordinator() {
        let data_dir = test_dir();
        let lease = CoordinatorLease::acquire(&data_dir).unwrap().unwrap();
        assert!(is_running(&data_dir).unwrap());
        assert!(CoordinatorLease::acquire(&data_dir).unwrap().is_none());
        assert!(request_stop(&data_dir).unwrap());
        assert!(lease.stop_requested().unwrap());
        drop(lease);
        assert!(!is_running(&data_dir).unwrap());
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn stop_request_without_a_running_instance_is_a_no_op() {
        let data_dir = test_dir();
        fs::create_dir_all(&data_dir).unwrap();
        assert!(!request_stop(&data_dir).unwrap());
        fs::remove_dir_all(data_dir).unwrap();
    }
}
