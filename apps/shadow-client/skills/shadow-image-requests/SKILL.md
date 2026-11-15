---
name: shadow-image-requests
description: Submit image requests to the paired Shadow Controller and retrieve the verified PNG or job error.
---

Use `shadow_submit_normal_image` for ordinary images, `shadow_submit_hot_image` for RedCraft and adult non-anime requests, or `shadow_submit_anime_image` for anime style. Pass the user's visual requirements in their original language. Preserve requests for transparency, image dimensions or aspect ratio, and LoRAs in the brief so the server can infer and validate those settings. The server prepares the diffusion prompt, chooses compatible LoRAs and validates sampling settings using its image preparation skill.

Check enrollment and connectivity with `shadow_client_status` and `shadow_relay_status`. Submit once with a fresh request UUID. Pass `filePath` for an explicitly selected prompt file so the tool reads it directly. Pass `brief` for a chat request. Standard output defaults to 1920 × 1080. The server can infer different dimensions from the brief.

Wait using `shadow_wait_job`. After a timeout or disconnect, query the same ID with `shadow_job_status`. Report a failed job's error. On success, use `get_image_result` and return the exact SHA-256-verified PNG as an attachment or local link.
