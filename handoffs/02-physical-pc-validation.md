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

## Dual-family deployment and tsup release checks
- Physical PC: initially register the **index/client** MCP family from local source; use Shadow launcher automation there only when model inference is unavailable and the launcher is installed.
- Shadow PC: register **both index/client and shadow/server families from project source**, without installing the npm release.
- Decide whether a separate Shadow-side server process/network transport is necessary only after testing direct LM Link and the existing MCP arrangements. If not needed, keep the server family as a local MCP module/entrypoint rather than deploying a new network service.
- Before publishing npm, verify tsup-built ESM/CJS formats as chosen, executable entrypoints, type declarations, exports, clean package installation on a disposable **physical-PC** test environment, and source-to-package parity.

## Dependency and model cleanup (approval-gated)
During implementation and physical-PC validation, inventory programs, runtimes, models, and worker dependencies that may become redundant. For each candidate, record its installation location, current consumers, replacement, storage impact, rollback or recovery method, and whether it is still needed by Bionic, LM Studio, existing MCP workers, or the Shadow Controller. Distinguish removing a project reference from uninstalling software or deleting model files. Do not uninstall, delete, or change production configurations without explicit user approval. Perform cleanup only after replacement behavior has been validated, and record approved changes and verification results in the appropriate handoff.

## Architecture decisions — persistent desktop orchestration (2026-11-02)
This section supersedes earlier assumptions that a separate Shadow-side server might be unnecessary. The server is now required; remote transport is still to be selected.

### Confirmed
- One server host (initially Shadow PC), multiple client installations. Server is a cross-platform installable Tauri desktop application, with an independently running background coordinator launched after user login (GUI session available); installers built by CI for supported Windows/Linux/macOS targets.
- Client is the Node.js/TypeScript MCP library built with tsup; keep both client/index and Shadow-local MCP families runnable from source on Shadow PC. Shadow never installs the published npm client.
- Firebase Authentication only, preferably Google sign-in, for user registration/login. Do not use Cloudflare as an identity provider. Remote network transport, relay and file transfer remain open design decisions. Validate Firebase SDK and available plugin integration during implementation; do not assume a Firebase connector is installed.
- Every request has a client-stable idempotency key (requestId) and a server-generated jobId. Repeated submissions return the original job and result, not duplicate generation. Persist state and results so restarted Codex can query by either ID.
- Durable SQLite queue, event log and crash recovery. On restart reconcile interrupted jobs with engine state and output files before retrying; automatically resume/requeue safe work. Record retry limits, job attempts, timeouts, cancellation and recovery errors. Never claim checkpoint resume if engine does not support it.
- Resource-aware scheduling groups compatible jobs by engine/model and VRAM requirements, while enforcing fairness, priority, aging and resource limits to prevent starvation. Stop/unload unused processes/models between incompatible workloads only when ownership and safe shutdown are established. LM Studio is on-demand, not assumed running at boot. Never terminate unrelated processes or disrupt existing workers.
- Server-generated media are volatile but retained for a configurable period; client stores accepted outputs permanently in project directories. Download confirmation must include integrity verification; protect active/in-flight and not-yet-acknowledged outputs from automatic cleanup, with explicit expiration policy and low-disk safeguards. Use platform-specific app data/cache directories, not OS temp as the only durable store.
- Server controls LM Studio, InvokeAI, audio/video adapters, model lifecycle, queue, resource reservations, logs, local asset storage, and authenticated remote commands. Tauri UI is separate from the persistent coordinator; GUI-dependent actions run in user session.
- Keep README.md and AGENTS.md unchanged until explicit user request. Do not uninstall programs or delete models without user approval.

### Design review sequence for upcoming conversations
1. Compare remote connectivity: Tailscale/private overlay, direct HTTPS/TLS with authentication, Cloudflare Tunnel as transport (not identity), outbound relay via Firebase-backed coordination, WebRTC/P2P, and hybrid options. Address NAT, firewalls, large file downloads, offline behavior, security, cost and operational complexity.
2. Prioritize server features and lifecycle (scheduler, crash recovery, process management, GUI, asset TTL, observability).
3. Select server libraries and architecture (Tauri/Rust, SQLite, process adapters, OS startup, CI installers).
4. Define client MCP tools, login, job submission/status/recovery, asset downloads and multi-client behavior.
5. Select client libraries, tsup packaging, transports and tests.
6. Design Firebase Google login, device pairing, token verification/refresh, roles and authorization; check Firebase plugin availability and use it if connected.

### Open questions
- Remote transport, NAT traversal, optional relay and file delivery; no choice made yet.
- Cache TTL, storage quota, pressure thresholds and policies for unacknowledged artifacts.
- Which engine processes can be safely unloaded/restarted, and per-engine recovery semantics.
- Authentication for headless CLI clients (interactive Google OAuth via device/browser flow or desktop pairing) and per-client permissions.
- Precise supported OS versions, startup mechanism, signed installer credentials and CI release approval.
