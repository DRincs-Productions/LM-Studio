---
name: shadow-image-requests
description: Submit image requests to the paired Shadow Controller and retrieve the verified PNG or job error.
---

Choose `normal` for ordinary images, `nsfw` for adult non-anime requests, or `anime` for anime style. Use `transparent` for isolated cutouts. Send the user's visual requirements in an English `brief`, preserving the requested details. The server prepares the diffusion prompt, chooses compatible LoRAs and validates sampling settings using its image preparation skill.

Check enrollment and connectivity with `shadow_client_status` and `shadow_relay_status`. Submit once with `shadow_submit_image` and a fresh request UUID. Standard output defaults to 1920 × 1080. Supply both dimensions to override it.

Wait using `shadow_wait_job`. After a timeout or disconnect, query the same ID with `shadow_job_status`. Report a failed job's error. On success, use `get_image_result` and return the exact SHA-256-verified PNG as an attachment or local link.
