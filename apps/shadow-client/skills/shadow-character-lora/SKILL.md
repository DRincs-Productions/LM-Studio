---
name: shadow-character-lora
description: Stage attached character reference images on OneDrive for a Shadow Controller LoRA draft.
---

# Stage character references

Check `shadow_client_status` and `shadow_relay_status`. Resolve the character with `lora_create_character_job` using the character ID, name, stable trigger, and a fresh request UUID. Reuse the returned job ID. A legacy editable draft can also be addressed directly by its job ID.

Call `lora_stage_character_batch` with the draft job ID, a fresh request UUID, and the local paths of the attached images. Assign each image a fresh UUID. Include the user's optional notes without inventing visible details. Reuse the same request and image UUIDs on retry.

Use one short English caption in this fixed order: `<stable character trigger>, <framing>, <body angle>, <pose>, <expression>, <explicit variation>`. The server builds it from Venice annotations. Omit fields that cannot be observed. Use full body, American shot, half body, close-up, or a tighter detail such as hands close-up. Use body angles in 45-degree increments starting at frontal 0 degrees. In a hands close-up, omit the expression and any angle that cannot be determined.

Only when the user explicitly flags a departure from the character's usual appearance, include a separate note line `unusual outfit: <short English description>`, `unusual object: <short English description>`, or `unusual feature: <short English description>`. The server includes a flagged item only if the image annotation confirms it is visible. Usual clothes, appearance, and background stay out of the caption.

Use `lora_status` to check every returned image ID. Confirm that the English captions describe the character and omit the background. Report preparation errors with the job and image IDs. Submit the draft with `lora_submit_character_job` when the user has authorized training and all references are ready.
