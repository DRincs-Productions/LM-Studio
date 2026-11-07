---
name: request-narration
description: Prepare and track a narration request for the paired Shadow Controller when the user invokes Shadow Narration.
---

Use the authenticated Shadow Controller MCP connection. Collect the registered project UUID, the SHA-256 of the selected canonical Project File revision, and the approved English scene brief. Preserve required beats, constraints, and ending condition. Do not invent IDs or hashes. Submit the request with `shadow_submit_narration` for a chat brief or `shadow_submit_narration_file` for a selected file; the file tool reads and submits it without exposing its contents in chat. Pass canon in `metadata.canon` only when the user supplied or selected it and it is available to the client.

After submission, wait with `shadow_wait_job` using the returned job or request ID. If the wait times out or disconnects, query that same job with `shadow_job_status`; never resubmit automatically. On completion, call `get_narration_result` to download the OneDrive scene and verify its SHA-256 before analysing or returning it. A completed-with-warnings result may contain a usable scene, but reviewer errors are not approval. Report the job state, manifest warnings and verified result. The server produces text and narrative cues only; image, audio and animation generation remain separate.

Before submitting client-driven test fixtures, follow the exact test procedure in the repository's `AGENTS.md`: check `shadow_client_status` and `shadow_relay_status`, use fresh IDs, preserve the prompt as a file, and never retry an uncertain job automatically.
