---
name: shadow-requests
description: Submit standard or uncensored narration to the paired Shadow Controller and retrieve the verified scene.
---

# Shadow Narration Requests

| Request | MCP tool | Final review |
|---|---|---|
| Standard narration from chat | `shadow_submit_narration` with `brief` | GPT-6 Luna (`openai/gpt-6-luna`) through OpenCode. |
| Standard narration from a selected file | `shadow_submit_narration_file` with `filePath` | GPT-6 Luna (`openai/gpt-6-luna`) through OpenCode. |
| Explicitly requested uncensored narration | `shadow_submit_uncensored_narration` with either `brief` or `filePath` | The configured Venice Uncensored model through OpenCode (default `venice/venice-uncensored-1-2`). |

Use the uncensored tool when the user asks for uncensored fiction, for example to preserve the requested intensity of adult intimacy or graphic violence. Hemmingway still writes the draft and the server still runs its scene checks. Venice does the final review directly after the free access check. For standard narration, the server tries Venice once if GPT-6 Luna refuses for policy reasons or has a technical failure. A scene validation failure by itself ends that review. If the uncensored tool reports an unsupported payload version, tell the user the server needs an update.

Supply the project UUID and SHA-256 of the selected project revision. Pass available, authorized canon in `metadata.canon`. Never invent a project ID or revision hash. For a selected file, pass its path and let the MCP tool read it. For a chat brief, preserve the required beats, constraints, and ending. The server returns an English scene.

Use the returned job or request ID with `shadow_wait_job`. After a timeout or disconnect, query the same ID with `shadow_job_status`. On completion, call `get_narration_result` to download the scene from OneDrive and verify its SHA-256. Return the verified file and report any review warnings. The scene can include narrative cues for future asset production.
