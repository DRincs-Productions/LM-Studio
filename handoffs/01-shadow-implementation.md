# Handoff 1 — Implement and test Shadow Controller on Shadow PC

Status: planned. Owner: Codex on Shadow PC. Next: implement and verify source-only MCP.

## Goal
Implement a reusable Node.js/TypeScript Shadow Controller MCP, its tests, configuration, Codex skill, and npm packaging. The initial development host is Shadow PC, where the Shadow launcher is not installed; therefore **launcher UI automation must not be claimed as tested**.

## Constraints
- Use the checked-out project source directly. **Do not install the published MCP package on Shadow PC**, now or in future development/test cycles.
- Do not disturb the existing Project, Image, Audio, or Asset Workers, Project File canon, or VRAM scheduling.
- Do not install or download models on the physical PC for this controller.
- LM Studio on Shadow PC is the inference runtime; the physical PC may later run llmster + LM Link as an API bridge. Detect actual endpoint/model availability, not merely process presence.
- Keep the MCP controller independent of the visual-novel production pipeline. No game code or production assets changed.
- Do not fake user activity, random-click, or bypass Shadow idle policies.
- Do not automate credentials or rely on hard-coded screen coordinates.

## Required behavior
1. For every requested operation, probe the configured LM Studio endpoint and validate the **target remote model**, using inference where readiness must be proven.
2. If inference works, skip all Shadow launcher discovery, startup, window inspection, and interaction—even when Shadow is closed or absent.
3. If inference fails, distinguish local API outage, LM Link disconnection, unloaded/wrong model, and remote host unavailability as far as evidence permits. Only then consider Shadow recovery.
4. Detect whether the official Shadow launcher is installed on the **machine running the MCP**. If absent, return structured diagnostics and do not attempt GUI actions.
5. If present, start the official launcher, inspect accessible UI elements, select only an unambiguously identified start/connect control, wait with bounded retries, and confirm readiness through remote-model inference. If UI is ambiguous or login required, stop with an actionable status.
6. Avoid concurrent startup attempts; use timeouts, cancellation, redacted logs, and deterministic state transitions.
7. Export tools such as `shadow_status`, `shadow_inspect_ui`, `shadow_start`, `shadow_wait_ready`, `shadow_ensure_ready`, `lmstudio_models`, and `lmstudio_inference`.
8. Provide a Codex skill named `shadow` (invoked as `$shadow`), but keep all safety/readiness rules enforced by MCP itself.
9. Design a stable npm package interface while running the local source in this phase.

## Implementation guidance
- Node.js + TypeScript, official MCP SDK, stdio transport, native fetch, Windows PowerShell UI Automation adapter with dependency injection.
- Separate launcher adapter, endpoint probing, LM Link model identification, orchestration state machine, and MCP registration.
- No ComfyUI integration is required: this repository uses sd-cli for image generation.
- Provide `.env.example`, tests, a packaging manifest, and Windows setup notes; no secrets in Git.
- Preserve compatibility with existing MCP registrations. Do not register the controller automatically in Bionic.

## Tests possible on Shadow PC
- Unit tests for state machine, retry/backoff, timeout, concurrency, diagnostics, and safe fallbacks using fake launcher/API adapters.
- MCP protocol smoke tests against the local source.
- Live LM Studio API and target-model inference tests where available.
- Verify the launcher-absent path; **mark all real launcher UI tests as pending physical-PC phase**.
- `npm test` and build/type checks, with actual commands/results recorded.

## Exit criteria and handoff
Record commit SHA, dependency versions, exact commands, passing/failing test results, known limitations, LM Studio endpoint/model test evidence, and physical-PC prerequisites. Do not claim distributed operation is verified until phase 2.
