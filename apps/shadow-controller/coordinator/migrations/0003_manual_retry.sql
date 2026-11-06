ALTER TABLE jobs ADD COLUMN retry_of_job_id TEXT;

CREATE INDEX jobs_retry_source ON jobs(retry_of_job_id)
WHERE retry_of_job_id IS NOT NULL;
