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

## Package topology decision (2026-11-02)
- Build the Node.js TypeScript library with **tsup** (required), including declarations and explicit package exports.
- Provide two logical module families: **index/client** for MCP capabilities invoked on the machine where Codex is running, and **shadow/server** for MCP capabilities that execute on Shadow PC. The names are logical roles, not a requirement to expose an HTTP service.
- Shadow PC must be able to run **both families from project source** because it is both a client and a server in this setup. Do not gate the client family on detecting the physical PC.
- Keep the Shadow-side network server **optional and undecided** until discovery confirms whether LM Link plus existing MCP transports cover all required operations. Do not expose an unauthenticated network endpoint or build an always-on service without demonstrated need.
- Support separate MCP stdio entrypoints (and shared core library) so both families can be registered independently or together on Shadow PC. Avoid tool-name collisions and circular dependencies.
- Add tsup build and package-export smoke tests to the phase-1 test matrix; distinguish package build verification from installing the package on Shadow PC.

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

### Firebase identity and Cloudflare request ingress refinement (2026-11-02)
- Firebase Authentication (Google provider preferred) is the only user identity system. Firebase also owns durable account-to-server pairing metadata. Exactly ONE registered server per Firebase uid, with multiple client devices; enforce uniqueness transactionally and support explicit secure replacement/revocation of a lost server.
- Cloudflare Worker is a proposed (not yet finalized) HTTPS ingress to verify Firebase ID tokens, authorize client against paired server and relay/queue commands. Cloudflare is NOT the identity provider. A Worker alone is stateless and cannot push commands to an offline Shadow PC; evaluate Durable Objects/WebSocket or durable mailbox. Shadow maintains an outbound authenticated connection, reconnecting automatically with backoff. Keep server SQLite authoritative for execution state and crash recovery; use durable remote inbox and idempotent request IDs to avoid lost/duplicate commands.
- Server must NOT require recurring interactive Google login. Firebase ID tokens typically last ~1 hour; refresh tokens can automatically renew sessions until revoked/invalidated. Store server refresh credentials in OS secure credential store, never plaintext or source control; consider pairing once via Google interactive login and issuing separate revocable device-bound credentials for the daemon, rather than tying permanent service identity to a user refresh token. Reconnect/restart should renew transparently; show login only if revoked, invalid, or re-pairing required.
- Verify Firebase JWT signature, issuer, audience, expiry, uid and server binding at ingress; check server authorization independently, protect against stolen tokens, enforce rate limits and replay/idempotency. Do not treat JWT validity as proof of device pairing. Define how revocation propagates and how session expiry affects running jobs (should not kill them).
- Media delivery remains undecided; avoid passing large PNG/MP4/WAV through Worker request payloads or WebSocket frames; prefer short-lived authenticated transfer URLs or separate file path. Confirm cost and limits before selection.
- Next discussion: explain automatic server auth/session refresh and compare simple polling mailbox versus Durable Objects/WebSocket relay, offline delivery, and recovery.

### Free-tier constraint and Shadow outbound connection (2026-11-02)
- User requires free services/plans only. Design Firebase Authentication (Google), Firestore pairing and Cloudflare Worker/Durable Object communication to fit available free tiers, validating current quotas, billing prerequisites and service availability before implementation; no silent paid upgrade or credit-card-dependent feature. Local storage and SQLite preferred; avoid default cloud media storage.
- Shadow initiates an outbound authenticated WSS connection to the Cloudflare Durable Object after Windows user login. The relay sends commands over this already-open bidirectional socket; no inbound port forwarding or Tailscale required. Auto reconnect with backoff, heartbeat, persisted mailbox/acknowledgment and request replay protection. Offline Shadow means commands must wait durably, not disappear; verify free-tier feasibility of persistent mailbox and WebSocket architecture.
