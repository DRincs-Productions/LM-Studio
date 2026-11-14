---
name: shadow-image-requests
description: Prepare model-specific image prompts and compatible LoRA selections, submit generation to the paired Shadow Controller, and retrieve the verified PNG or error.
---

1. Choose the profile from the requested style and subject. Codex drafts the prompt for `normal` (Krea2 Turbo). Use `shadow_prepare_image_prompt` for `nsfw` (RedCraft v3.0) and `anime` (Krea2 Anime v2.0), which obtains a text-only draft from Venice via the client's OpenCode. Surface an unavailable provider as an error.
2. Read the applicable model reference and [LoRA selection](references/loras.md). [RedCraft v3.0](references/redcraft-v3.md) is the first model-specific guide. For Krea2 Turbo and Krea2 Anime, use plain English descriptions of composition, subject, action, lighting and style until model-specific guidance is added. Choose compatible ready adapters only when their documented effect serves the request. Avoid adding new scene facts or visual requirements.
3. Check enrollment and relay connectivity with `shadow_client_status` and `shadow_relay_status`. Submit once with `shadow_submit_image`, using a fresh request UUID, an English `prompt`, profile, optional `negativePrompt` and structured `loras`. For a cutout use `transparent`. Standard output defaults to 1920 × 1080. Supply both dimensions to override it. The server checks the payload and adapter registry, generates the image, and gives the reviewer the effective prompt and settings.
4. Wait using `shadow_wait_job`. After a timeout or disconnect, query the same ID with `shadow_job_status`. A failed job yields an error. On success, use `get_image_result` and return the exact SHA-256-verified PNG as an attachment or local link.
