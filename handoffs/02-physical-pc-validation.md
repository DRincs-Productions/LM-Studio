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

### Free Cloudflare WebSocket and rclone/OneDrive artifact transport (2026-11-02)
- Confirmed repository README identifies rclone as existing transfer utility and configured remote alias imagecloud:; README does NOT establish that imagecloud: is backed by OneDrive. Inspect rclone config type locally without printing tokens/secrets; do not modify README.md or AGENTS.md.
- User proposes OneDrive as volatile cross-network file exchange through rclone. OneDrive personal free tier currently advertises 5 GB; verify actual account quota and API/provider behavior before implementation. Keep large binary assets out of Cloudflare WebSocket/Worker.
- Cloudflare Workers Free plus SQLite-backed Durable Objects and WebSocket Hibernation API can support continuously available connections within free quotas, but no guarantee of uninterrupted socket; implement reconnect, durable inbox, retry, rate-limit/backoff and quotas. Hibernation is essential to avoid active duration usage.
- On EVERY server startup, inspect only the application's dedicated OneDrive/rclone namespace; delete objects older than 7 days, based on stable upload/creation metadata or server manifest, never arbitrary OneDrive user files. Define UTC cutoff and protect incomplete uploads, active downloads and transfers. Treat user-requested automatic deletion as scoped to app-owned remote objects only.
- Before uploading a file, inspect available OneDrive quota. If insufficient, reclaim oldest eligible app-owned remote files until required upload size PLUS 500 MiB free headroom is available; if impossible, fail safely and report insufficient storage, never delete unrelated OneDrive files. Account for free-tier quota, trash/recycle-bin retention, delayed quota release, concurrent uploads and exact units; verify quota again before retrying.
- Keep generated artifacts in server-local managed cache for configured TTL independently of OneDrive. If requested OneDrive file is absent but matching verified local artifact exists, republish on demand via rclone. Client Codex may request remote artifact by filename, but enforce canonical app namespace, normalized relative paths, ownership, ambiguity handling, and stable jobId/artifactId to prevent traversal or collisions. Return remote path and manifest/hash; client downloads and verifies file before permanent project storage. Prefer rclone copy and checks rather than destructive sync.
- Deletion must not erase last unacknowledged copy before agreed retention/recovery policy; surface conflict between 7-day remote expiry and delayed client download. Avoid cloud quota promises; test end-to-end on Shadow.
