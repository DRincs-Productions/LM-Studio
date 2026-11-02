# Handoff 2 — Validate Shadow Controller on the physical Windows PC

Status: blocked until Handoff 1 is implemented and its results recorded. Owner: Codex on the always-on physical Windows PC.

## Goal
Exercise the official Shadow launcher, real Windows UI Automation, LM Link connectivity, and remote-model inference end to end. Fix implementation issues, then transition from source-based MCP usage on the physical PC to the released npm library.

## Prerequisites
- Source-based controller from phase 1, with reproducible build and test results.
- Official Shadow PC launcher installed on the physical Windows host.
- LM Studio running on Shadow PC, with LM Link enabled and a known target model.
- llmster on the physical PC if chosen as the LM Link local API endpoint; verify the endpoint rather than assuming `localhost:1234` exists.
- Access to Codex VS Code and a test session that may be started/stopped safely.
- Explicit authorization before starting or changing the Shadow session.

## Test matrix
1. **Model already responds**: ensure no Shadow launcher lookup, UI inspection, startup, or mouse action occurs, even if the launcher is absent or closed.
2. **API responds but target model does not**: identify model/LM Link issue and avoid unwarranted power-on.
3. **No launcher installed**: return a clear, non-crashing diagnostic.
4. **Launcher installed, session off**: start launcher, identify the intended start/connect control, wait, and verify target-model inference.
5. **Launcher running, session already active**: reuse it without unnecessary interaction.
6. **Login, ambiguous UI, update prompt, or error dialog**: stop safely and request human intervention.
7. **Network disconnect, startup timeout, repeated invocations**: bound retries, prevent duplicate startup, and report recovery actions.
8. **Long tasks**: health monitoring only; no random cursor movement/clicks to imitate activity.

## Migration and release
- First register the **local source** with Codex and run the complete matrix.
- Fix problems on the feature branch; re-run tests and record evidence.
- Publish a versioned npm package only after validating package contents, entrypoints, licenses, README, CI, and release permissions.
- On the **physical PC**, migrate Codex MCP registration from local source to the npm package; verify behavior again and document rollback.
- On **Shadow PC**, continue using the project source directly. **Never install the published MCP library there.**

## Exit criteria
Provide reproducible logs (redacted), real launcher UI test outcomes, inference evidence, npm package version, migration commands, rollback procedure, and any remaining limitations. No claim of full support until real physical-PC tests pass.
