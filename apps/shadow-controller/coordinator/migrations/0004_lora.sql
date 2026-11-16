CREATE TABLE IF NOT EXISTS lora_jobs (
    id TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    client_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    config TEXT NOT NULL,
    attached_at TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'waiting',
    detail TEXT,
    UNIQUE(uid, client_id, request_id)
);
