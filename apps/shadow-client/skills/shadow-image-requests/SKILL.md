---
name: shadow-image-requests
description: Submit image generation and transparent cutout requests to the paired Shadow Controller and retrieve the exact verified PNG.
---

Check the client and relay with `shadow_client_status` and `shadow_relay_status`. If the client is unauthenticated or the server is offline, report the blocker.

Submit once with `shadow_submit_image`, using a fresh request UUID and an English brief. Use `normal` for ordinary images, `nsfw` for adult non-anime images, and `anime` when the requested style is anime. Use `transparent` for an isolated cutout. Default output is a standard PNG at 1920 × 1080. Supply both dimensions for custom sizes. Pass explicit LoRA IDs and weights only for documented, compatible adapters requested by the user. The server resolves model and adapter settings.

Use `shadow_wait_job` on the returned job or request ID. After a disconnect or timeout use `shadow_job_status` with the same ID. A rejected review is a failed generation request. Do not resubmit automatically.

On success, call `get_image_result` with the job ID. Return the exact hash-verified PNG it downloads as an attachment or a clickable local path. Report the server error if integrity verification fails.
