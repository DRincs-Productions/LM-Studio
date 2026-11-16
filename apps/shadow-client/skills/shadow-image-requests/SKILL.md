---
name: shadow-image-requests
description: Submit standard, adult, or anime image requests to Shadow Controller and retrieve the verified PNG.
---

# Shadow Image Requests

| Image requested | MCP tool | Model |
|---|---|---|
| Standard non-anime image | `shadow_submit_normal_image` | Krea2 Turbo |
| Adult non-anime image | `shadow_submit_hot_image` | RedCraft |
| Anime image, including adult anime | `shadow_submit_anime_image` | Krea2 Anime |

All three tools accept background transparency. If the user asks for a cutout or a transparent background, include that requirement in the brief in the user's language. For example, a brief can ask for an isolated character on a transparent background. Shadow Controller prepares the generation prompt, selects a solid background suitable for removal, removes it after generation, and returns a PNG with transparency.

Use `brief` for a chat request or `filePath` for a selected prompt file. Preserve the user's visual requirements, including dimensions, aspect ratio, and any requested LoRA. Shadow Controller interprets those requirements and checks adapter compatibility. Standard output defaults to 1920 × 1080 when the brief gives no size preference.

Follow the shared workflow in [shadow-requests](../shadow-requests/SKILL.md). Use `get_image_result` to retrieve the verified PNG.
