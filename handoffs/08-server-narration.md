# Handoff 08 — Server narration through Shadow Controller

## Client request and queue

The client exposes two narrative entrypoints through its MCP server: `shadow_submit_narration` for a chat brief and `shadow_submit_narration_file` for an explicitly selected UTF-8 file. The file tool reads and sends the file itself, so the client model does not need to inspect it before submission. Both send `narrative.generate` v1 with `projectId`, `projectSha256`, `brief`, optional `metadata`, and a stable request ID. Requests are authenticated, size-checked, persisted in the server SQLite FIFO queue and idempotent by request ID. Duplicate submissions return the existing job; conflicting reuse is rejected. Jobs are not automatically replayed after restart.

`projectSha256` is currently an identifier supplied by the client. The server does not resolve a project registry or retrieve canonical project contents from that hash. If the client has authorized canon text, it can be included in `metadata.canon`; otherwise the Writer receives only the brief and the result records that the canon was absent. Do not claim that the server verified the revision or that the brief's content is approved merely because the hash is present.

## Server workflow

The server Coordinator executes one job at a time and uses the original brief and available canon directly. It does not ask Codex to plan or draft a proposal before Writer generation.

1. The Writer creates the English scene with the project's Markdown envelope and NCF cue conventions. Cues are directions in text; the narration operation does not generate images, audio or animation assets.
2. Gemini CLI in Auto mode reviews the original brief, available canon and latest usable draft. The Coordinator allows up to five review calls. Actionable feedback is sent to the Writer for a focused revision; a pass ends review early.
3. If Gemini errors, refuses, returns malformed output or reaches the review limit, record the stage outcome and reason. Continue with the latest usable draft; do not represent an error or exhaustion as a pass.
4. Codex receives the original brief, available canon, latest usable draft and Gemini stage outcomes. It checks the complete request and may make a bounded improvement. Accept only a scene matching the required artifact envelope; otherwise retain the latest usable draft and record the Codex error.
5. Validate the selected scene, save stage evidence and the local manifest, upload it with rclone to `imagecloud:NarrationWorker/final/<jobId>/scene.md`, and download/read back the remote bytes. Compare SHA-256 before returning a reference.
6. Unload the job-owned Writer model after the complete review cycle. Gemini and Codex are command processes and must have exited before delivery. Cleanup failure is included in the manifest and changes an otherwise usable result to `completed_with_warnings`. Cancellation, timeout, process failure and interruption preserve evidence; uncertain work is not replayed automatically.

The server requires `SHADOW_NARRATION_MODEL`. Optional environment settings are `SHADOW_LM_API_BASE_URL` (default `http://127.0.0.1:1234`), `SHADOW_NARRATION_CONTEXT`, `SHADOW_LMS_EXECUTABLE`, `SHADOW_GEMINI_EXECUTABLE`, `SHADOW_CODEX_EXECUTABLE`, and `SHADOW_RCLONE_EXECUTABLE`. The same server account needs the configured LM Studio model, `lms`, Gemini CLI, authenticated Codex CLI and the rclone `imagecloud:` remote.

## Result and client retrieval

The authenticated job status includes the server result manifest. It carries `jobId`, `requestId`, manifest status (`succeeded`, `completed_with_warnings`, `failed`, or `cancelled`), `narrativeRemotePath`, `narrativeSha256`, `projectSha256`, `selectedDraft`, stage outcomes/attempts/error codes/reasons, and warnings where applicable. A path and hash are returned only for a usable, remotely verified scene. Queue state may be `succeeded` while the manifest status is `completed_with_warnings`; the manifest is authoritative for stage outcomes.

The client calls `get_narration_result` with `jobId`. That MCP tool resolves the authenticated job status, downloads only the expected OneDrive path through rclone, verifies the SHA-256, and writes an exclusive local copy. The client must complete this download and integrity check before reading or analysing the scene. A failed verification returns an error and no usable local path.

The client skill is [Shadow Requests](../apps/shadow-client/skills/shadow-requests/SKILL.md), included in the client package and installed with `shadow-client install-skill`. The standalone local planning role is separately documented in [Handoff 09 — Bionic Regia](09-bionic-regia.md).
