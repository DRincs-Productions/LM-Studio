---
name: shadow-narration-requests
description: Submit standard or uncensored narration to the paired Shadow Controller and retrieve the verified scene.
---

# Shadow Narration Requests

| Request | MCP tool | Final review |
|---|---|---|
| Standard narration | `shadow_submit_narration` with `brief` for chat, or `shadow_submit_narration_file` with `filePath` for a selected file | GPT-6 Luna (`openai/gpt-6-luna`) through OpenCode. |
| Explicitly requested uncensored narration | `shadow_submit_uncensored_narration` with either `brief` or `filePath` | The configured Venice Uncensored model through OpenCode (default `venice/venice-uncensored-1-2`). |

Use the uncensored tool when the user asks for uncensored fiction, for example to preserve the requested intensity of adult intimacy or graphic violence. Hemmingway still writes the draft and the server still runs its scene checks. Venice does the final review directly after the free access check. For standard narration, the server tries Venice once if GPT-6 Luna refuses for policy reasons or has a technical failure. A scene validation failure by itself ends that review. If the uncensored tool reports an unsupported payload version, tell the user the server needs an update.

Supply the project UUID and SHA-256 of the selected project revision. Pass available, authorized canon in `metadata.canon`. Never invent a project ID or revision hash. For a selected file, pass its path and let the MCP tool read it. For a chat brief, preserve the required beats, constraints, and ending. The server returns an English scene.

Follow the shared workflow in [shadow-requests](../shadow-requests/SKILL.md). Use `get_narration_result` to retrieve the verified Markdown scene. The scene can include narrative cues for future asset production.
