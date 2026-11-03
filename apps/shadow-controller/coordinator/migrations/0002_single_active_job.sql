INSERT INTO job_events (
    job_id,
    occurred_at,
    event_type,
    previous_state,
    new_state,
    message_redacted
)
SELECT
    job_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'job.interrupted_during_single_active_migration',
    state,
    'interrupted',
    'Job was active while the single-active-job database constraint was introduced'
FROM jobs
WHERE state IN ('running', 'cancel_requested');

UPDATE jobs
SET state = 'interrupted',
    finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    error_code = 'interrupted_during_single_active_migration'
WHERE state IN ('running', 'cancel_requested');

UPDATE job_attempts
SET finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    outcome = 'interrupted'
WHERE finished_at IS NULL
  AND job_id IN (SELECT job_id FROM jobs WHERE error_code = 'interrupted_during_single_active_migration');

CREATE UNIQUE INDEX jobs_single_active
ON jobs ((1))
WHERE state IN ('running', 'cancel_requested');
