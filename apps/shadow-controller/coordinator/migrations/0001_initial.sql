CREATE TABLE requests (
    uid TEXT NOT NULL,
    client_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_version INTEGER NOT NULL,
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (uid, client_id, request_id)
) STRICT;

CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    client_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'succeeded', 'failed',
        'cancel_requested', 'cancelled', 'interrupted'
    )),
    fifo_sequence INTEGER NOT NULL UNIQUE CHECK (fifo_sequence > 0),
    engine TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    timeout_at TEXT,
    error_code TEXT,
    result_manifest TEXT,
    FOREIGN KEY (uid, client_id, request_id)
        REFERENCES requests(uid, client_id, request_id)
) STRICT;

CREATE INDEX jobs_fifo_queue ON jobs(state, fifo_sequence);
CREATE INDEX jobs_owner_created ON jobs(uid, client_id, created_at DESC);

CREATE TABLE job_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    occurred_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    message_redacted TEXT
) STRICT;

CREATE INDEX job_events_job_order ON job_events(job_id, event_id);

CREATE TABLE job_attempts (
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    cause TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT,
    process_reference TEXT,
    output_reference TEXT,
    PRIMARY KEY (job_id, attempt_number)
) STRICT;

CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    relative_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    cache_path TEXT,
    transfer_state TEXT NOT NULL CHECK (transfer_state IN (
        'local', 'uploading', 'published', 'downloaded', 'failed'
    ))
) STRICT;

