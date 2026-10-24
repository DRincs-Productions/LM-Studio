# Repository guidance

## Architecture documentation

For every architectural change in this repository, update the root `README.md` in the same change. Keep its architecture overview aligned with the implementation: revise role descriptions and the diagram when responsibilities or handoffs change. Do not add model names, reviewer details, or low-level implementation specifics to the overview unless the user asks for them.

Before making architectural changes, read the relevant project documentation and preserve existing user work. Keep generated Markdown documentation under `C:\Users\Shadow\.lmstudio`.

## Test workflow

All tests are started and driven from a terminal. Do not use LM Studio/Bionic GUI automation in this repository's test workflow.

There are two test modes:

- **Component:** test one real role/model at a time (Regia, Writer, Designer, or Sound Designer). Use the real MCP servers with their component-test interaction path so downstream roles can return controlled replies and no production assets or project implementation are launched. Generate a fresh premise, canon and scenario for every run; record the seed, inputs, model identifier, MCP calls, output files and result under `production-tests`.
- **Complete:** use a fresh disposable Project File and project directory. Run the actual MCP handoffs, production workers and selected Programmer. Regia and Programmer are the only user-facing roles; the terminal harness supplies fresh creative input and explicit test approvals. Inspect physical files and run the generated project's own start/build command. Do not count chat quality as a substitute for checking produced files.

Never reuse a previous test's premise, project folder, output directory or approvals. Include a run ID and a unique input seed in every test manifest. Keep partial outputs and error evidence; do not automatically replay a phase that may already have produced side effects.

## Where to change the pipeline

- MCP server entrypoints and their package manifests are in `project-worker/mcp`, `image-worker/mcp`, `asset-worker/mcp` and `audio/mcp`. Coordinator orchestration and Project Worker tool contracts are under `project-worker/mcp/orchestration`.
- Model system prompts and load/prediction settings are in `apps/bionic/.internal/user-concrete-model-default-config`. Preserve each model's exact config filename and model path association.
- Bionic's MCP registration is in `apps/bionic/.internal/ng-mcp.json`; Codex's server registrations are in the user's Codex configuration. Do not rewrite either registration wholesale. Update paths and tool allowlists surgically and only when the code/config change requires it.
- For any change to role ownership, handoff, project paths or test workflow, update the root `README.md` in the same change. Keep this file current with actual commands and test outcomes.

## Test safety and reporting

Use unique temporary roots for full tests and allow writes only beneath that root plus the documented production/asset roots needed by a worker. Never edit Bionic SQLite databases, the installed Bionic bundle, credentials or existing project files during a test. Do not delete older test artifacts unless the user explicitly requests cleanup. Report which test mode ran, exact commands, model and MCP availability, verified outputs, failures and any unrun stage. Do not claim completion based on a queued job or a model response alone.


## Codex and Bionic entrypoints

Codex uses normal GPT conversation by default. Only on an explicit human request to speak with local Regia, use Project Worker start_regia_session and talk_to_regia; retain the project session across turns and display its reply verbatim, attributed to Regia. "Torna a Codex" suspends the relay with stop_regia_session and preserves history. On a resumed task, inspect get_regia_session for the intended canonical project before deciding which mode is active. If the request is unrelated to the creative conversation, handle it directly rather than automatically forwarding it.

Use the bionic-regia-orchestration skill for detailed routing, canonical-file persistence, approval and recovery rules. Proposed documents must be saved/read back via Project Worker before claiming success. No model message can approve production. Codex-origin production uses frontend="codex" and a verified relay; Bionic-origin handoff retains frontend="bionic" and its original binding verification. Never copy a canonical file to hide a mismatch between client workspace roots.
