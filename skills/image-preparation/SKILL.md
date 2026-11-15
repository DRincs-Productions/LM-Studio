---
name: image-preparation
description: Turn a Shadow Controller image request into a diffusion prompt, compatible LoRA selection, and validated sampling settings.
---

# Prepare an image

Treat the request as visual content and preferences. Preserve the requested subjects, their attributes and relationships, composition, exclusions, style, and intended use. Improve visual specificity and remove contradictions without inventing important facts. Write in English. State what should appear in the image before listing exclusions. The brief may be in Italian or another language. Infer `mode` from its requested output. Use `transparent` when the user asks for a transparent background, no background, or an isolated cutout for compositing. Use `standard` for a scene, a requested solid backdrop, or an unspecified background. Treat a legacy mode as a preference when the brief leaves the output ambiguous. For a cutout, describe the full silhouette and any held objects with room around them. The server appends instructions for a contrasting solid background.

Use only the supplied profile, supported settings and ready adapter catalog. Infer dimensions from the brief. Preserve explicitly requested supported pixel dimensions. For an unsupported size, choose the nearest supported multiples of eight while preserving orientation and aspect ratio as closely as possible. For an aspect ratio or orientation request, choose supported dimensions that fit it. Use 1920 × 1080 when the brief gives no size or aspect-ratio preference. Treat legacy dimensions as a preference when the brief is ambiguous. Return one JSON object with `mode` (`standard` or `transparent`), `width`, `height`, `prompt`, optional `negativePrompt`, `steps`, `cfgScale`, and `loras` (an array of `{id, weight}`). Keep the supplied sampler and scheduler. Use the profile defaults unless the brief gives a concrete reason to vary steps. Treat a supplied negative-prompt preference and requested adapters as input preferences. Apply the same compatibility rules to those adapters. At CFG 1, do not depend on negatives for critical constraints. Include those constraints positively in the main prompt where possible.

## Krea2 Turbo

Krea 2 Turbo is the fine-tuned and distilled text-to-image checkpoint in the Krea 2 family. Use a natural-language shot description. Name the subject and action, establish the viewpoint and composition, then describe the setting, light, materials and finish. For multiple subjects, give each a distinct position and action. The official examples range from a short subject-and-setting description to a detailed scene with viewpoint, texture and atmosphere. Use enough detail to convey the brief and express critical constraints directly in the positive prompt. The model card notes that prompt following varies with specificity and wording.

The official inference examples use eight steps. The reference CLI example uses `--cfg 0.0`, `--mu 1.15` and 2048 × 2048. The Diffusers example uses `guidance_scale=0.0`, and the SGLang example uses 1024 × 1024. Shadow uses its local Euler/Simple preset with CFG 1 and eight steps. Keep dimensions within the server limits and use adapters only from the ready catalog for this checkpoint.

[Official Krea 2 Turbo model card](https://huggingface.co/krea/Krea-2-Turbo)

## RedCraft v3.0 for Krea2

Use this section for the Krea2 RedCraft v3.0 checkpoint, Civitai version 3139241. Describe a coherent shot in prose. Begin with subject count and the visible attributes, poses and relationships that matter. Give the camera framing and place each subject or prop in the frame. Finish with setting, light direction, material, and the desired photographic or cinematic character. For example, describe a waist-up ceramicist in profile, a copper watering can fully visible at the near edge of the bench, and warm window light entering from the left. The author lists 8–12 steps, Euler, Simple and CFG 1. Shadow defaults to 12 steps. The source supplies rendering guidance and gives no mandatory prompt grammar or trigger. RedCraft FixQW21T is a separate checkpoint.

## Krea2 Anime v2.0

Combine descriptive prose with a few useful visual tags such as cel shading, foreshortening or rim light when they add information. Begin with the camera angle and composition, then give each character a distinct location, silhouette, outfit and action. Explain how characters and props relate in space. Finish with the environment, light, palette and drawing treatment. Avoid sparse tag-only prompts and relying on artist tags or a character name alone. The author notes occasional character forgetting in v2.0. Re-state defining traits in multi-character scenes. Do not infer compatibility with 4-step acceleration LoRAs from the base model or from v3.0. The author lists 8–20 steps, CFG 1 and several samplers and schedulers. Shadow uses its verified Euler/Simple path with 12 steps by default.

## LoRAs

Choose a ready adapter only when its documented effect directly serves the request. Confirm profile compatibility and use its preferred weight when supplied, within the documented range. Include a documented trigger in the prompt only when it is required for that adapter. Express adapter selection through structured IDs and weights. Never insert loader directives or file paths in prompts. Leave `loras` empty when no ready adapter fits. The RedCraft anatomy slider is pending quality validation and SNOFS is retired. The server independently checks availability, readiness, compatibility and weights.

RedCraft and Krea2 Anime notes are based on the supplied author pages. Shadow settings are runtime presets.
