---
name: shadow-requests
description: Route Shadow Controller requests and handle the shared MCP workflow from client enrollment to verified delivery.
---

# Shadow Requests

The client submits a brief over the authenticated relay. Shadow Controller queues the job, prepares and runs the requested production workflow, checks the result, and publishes completed files to OneDrive for retrieval through MCP.

## Choose the request

- Use [shadow-narration-requests](../shadow-narration-requests/SKILL.md) for standard or uncensored narration, including reviewer selection and project revision inputs.
- Use [shadow-image-requests](../shadow-image-requests/SKILL.md) for standard, adult, or anime images, including transparent backgrounds.

## Submit, track, and deliver

1. Check enrollment with `shadow_client_status` and paired server availability with `shadow_relay_status`. If enrollment or connectivity is missing, report the blocker before submitting.
2. Choose the MCP tool from the relevant skill. For a chat request, pass the brief and preserve the user's requirements. For an explicitly selected prompt file, pass its path so the tool reads the file directly. Use a fresh request UUID and keep the returned job and request IDs.
3. Wait with `shadow_wait_job`. After a timeout or disconnect, check the same ID with `shadow_job_status` before taking further action. Only use `shadow_retry_job` for an eligible failed job when the user explicitly requests a retry.
4. Use the result tool specified in the relevant skill to download and verify the file against the manifest SHA-256. Return the exact verified file as an attachment or local link. Report errors or manifest warnings, including when the server returns a usable draft after a review failure.

## Access and connection

| MCP tool | When to use it |
|---|---|
| `shadow_login` | Sign in through the browser and enroll the local client. |
| `shadow_client_status` | Check local sign-in and enrollment before submitting a request. |
| `shadow_register_client` | Retry enrollment of the local client's public key when sign-in succeeded but enrollment did not. |
| `shadow_logout` | Revoke this client's authorization and remove local credentials when the user asks to sign out. |
| `shadow_auth_token_status` | Diagnose authentication by checking whether Firebase can refresh the client's identity token. |
| `shadow_relay_status` | Check whether the client can authenticate to the relay and whether the paired server is online. |

## Generic requests

Use `shadow_submit_job` when you have a supported operation and its payload. Pass `operation`, `payload`, and the applicable `payloadVersion` (defaults to 1). For example, `codex.execute` accepts a payload with a `task` string. Keep the request ID for status checks. Use the specialized skills above for narration and image requests.

## Jobs

| MCP tool | When to use it |
|---|---|
| `shadow_job_status` | Look up the state and available result manifest by `jobId` or `requestId`. Use the same ID after a timeout or disconnect. |
| `shadow_wait_job` | Poll an existing job by `jobId` or `requestId` until it finishes or the wait reaches `timeoutSeconds`. |
| `shadow_list_jobs` | List recent jobs visible to this client. Pass `limit` to control the number returned. |
| `shadow_cancel_job` | Request cancellation of a queued or running job by `jobId`. Check its status for server confirmation. |
| `shadow_retry_job` | Queue a new run for an eligible failed job by `jobId` when the user explicitly requests a retry. Keep the `retryRequestId` and query it as the request ID if the submission outcome is uncertain. |

## Published assets

| MCP tool | When to use it |
|---|---|
| `shadow_list_assets` | List published asset references and available metadata. Use `jobId` to filter by job and `limit` to control the number returned. |
| `shadow_get_asset` | Look up a published asset by `assetId` to retrieve metadata or a download reference. For verified scene and PNG downloads, use the result tool in the relevant specialized skill. |
