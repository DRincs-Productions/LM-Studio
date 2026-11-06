---
name: shadow-requests
description: Submit narrative and other creative requests to the paired Shadow Controller server, then retrieve and verify returned files through its MCP tools before reviewing them.
---

# Shadow Requests

Use the local Shadow Controller MCP tools to route a request to the paired server. The server coordinates production; the client submits requests and receives files.

## Narrative requests

For a request given in chat, call `shadow_submit_narration` with the project UUID, the SHA-256 of the selected project revision, and the user's request as `brief`. Pass canon in `metadata.canon` only when the user supplied or selected that canon and it is actually available to the client. Do not invent a hash or claim the server validated the project revision from its hash alone.

For a selected request file, call `shadow_submit_narration_file` with its path, project UUID, revision SHA-256, and optional metadata. The MCP tool reads and transmits the file directly. Do not open or quote the file in chat before submission. Keep request metadata limited to project material needed by the server.

After submission, use the returned request ID with `shadow_wait_job` or `shadow_job_status`. Do not resubmit because of a timeout or disconnect; query the same request ID. When the server finishes, call `get_narration_result` with the job ID. It downloads the OneDrive reference through the MCP client, verifies the SHA-256, and returns a local file path. Only then read and analyse the downloaded scene. Report review errors or warnings from the job result; do not treat a failed reviewer as approval.

The server returns English narrative and may include Visual, Music, SFX, or Animation cues. Those cues are text directions; they do not mean assets were created. Asset generation remains a separate request. Regia is a separate Bionic planning conversation described in [Handoff 09](../../../handoffs/09-bionic-regia.md).

## Other requests

Use `shadow_submit_job` with `operation: "codex.execute"` only for generic tasks intended for server-side Codex. Use the job ID or request ID to poll; do not submit the same action again automatically.

Use `shadow_retry_job` only after the user explicitly requests a retry for a job in the `failed` state. Preserve a `retryRequestId` when checking an uncertain retry: query it with `shadow_job_status` before asking for another run. Interrupted jobs are not eligible because the previous outcome may be uncertain.
