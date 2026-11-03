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

### Free Cloudflare WebSocket and rclone/OneDrive artifact transport (2026-11-02)
- Confirmed repository README identifies rclone as existing transfer utility and configured remote alias imagecloud:; README does NOT establish that imagecloud: is backed by OneDrive. Inspect rclone config type locally without printing tokens/secrets; do not modify README.md or AGENTS.md.
- User proposes OneDrive as volatile cross-network file exchange through rclone. OneDrive personal free tier currently advertises 5 GB; verify actual account quota and API/provider behavior before implementation. Keep large binary assets out of Cloudflare WebSocket/Worker.
- Cloudflare Workers Free plus SQLite-backed Durable Objects and WebSocket Hibernation API can support continuously available connections within free quotas, but no guarantee of uninterrupted socket; implement reconnect, durable inbox, retry, rate-limit/backoff and quotas. Hibernation is essential to avoid active duration usage.
- On EVERY server startup, inspect only the application's dedicated OneDrive/rclone namespace; delete objects older than 7 days, based on stable upload/creation metadata or server manifest, never arbitrary OneDrive user files. Define UTC cutoff and protect incomplete uploads, active downloads and transfers. Treat user-requested automatic deletion as scoped to app-owned remote objects only.
- Before uploading a file, inspect available OneDrive quota. If insufficient, reclaim oldest eligible app-owned remote files until required upload size PLUS 500 MiB free headroom is available; if impossible, fail safely and report insufficient storage, never delete unrelated OneDrive files. Account for free-tier quota, trash/recycle-bin retention, delayed quota release, concurrent uploads and exact units; verify quota again before retrying.
- Keep generated artifacts in server-local managed cache for configured TTL independently of OneDrive. If requested OneDrive file is absent but matching verified local artifact exists, republish on demand via rclone. Client Codex may request remote artifact by filename, but enforce canonical app namespace, normalized relative paths, ownership, ambiguity handling, and stable jobId/artifactId to prevent traversal or collisions. Return remote path and manifest/hash; client downloads and verifies file before permanent project storage. Prefer rclone copy and checks rather than destructive sync.
- Deletion must not erase last unacknowledged copy before agreed retention/recovery policy; surface conflict between 7-day remote expiry and delayed client download. Avoid cloud quota promises; test end-to-end on Shadow.

### User-selected rclone-sdk on server and MCP client (2026-11-02)
- User chooses maintained npm rclone-sdk as a peer dependency on the TypeScript MCP/client side, and wants rclone-sdk-driven OneDrive authorization on both client and server. Client user selects their own Microsoft/OneDrive account; do NOT require Microsoft account identity equality with server, though operations must still check remote/file availability and errors. Firebase identity/pairing remains independent.
- Important implementation constraint verified against upstream: rclone-sdk is a TypeScript client of rclone Remote Control HTTP API, NOT a standalone rclone executable or OneDrive OAuth implementation. A local rclone executable and local RC daemon are still required on each machine; bundle/version-pin official binary as sidecar, potentially uninstall obsolete system-wide installation ONLY after backup of existing rclone config and validated migration, and only with explicit execution approval. Never uninstall automatically as part of this planning note.
- Tauri/Rust backend can use native rclone-sdk Rust crate (separate package) or HTTP RC client; npm peer dependency is relevant to TypeScript MCP package, not directly to Rust Tauri. Define peerDependencies and development dependency and verify runtime availability.
- Each side independently configures OAuth through rclone's config/create / config/update and config OAuth flow exposed via RC (or managed rclone CLI as needed); SDK orchestrates RC calls but OAuth is performed by rclone and Microsoft. Store separate credentials securely; never forward RC port over Cloudflare or expose to remote clients. RC is highly privileged, keep on loopback or private IPC with authentication, and scope MCP commands to allowlisted remote operations/path namespace.
- Critical behavior: different OneDrive accounts do not automatically share files. Client can download server uploads only when the selected account has access to the same OneDrive folder/file (shared folder permissions or a supported share-link approach). Do not claim cross-account access otherwise. Design setup/error UX accordingly.

### Simplified rclone transfer design confirmed (2026-11-02)
- Keep file transfer ESSENTIAL and provider-agnostic: rclone remote may target OneDrive or any other rclone-supported backend. Each client MCP uses rclone-sdk with the remote name selected at initial configuration (e.g. imagecloud:); no preflight Microsoft identity match, no complex account correctness checks. Cross-account sharing uses an accessible shared folder, otherwise ordinary transfer error. Remote name must be stored per client and may differ across machines.
- Tauri server may invoke rclone executable via terminal/subprocess directly; do not force Node.js SDK process in Rust backend. Avoid exposing unrestricted terminal commands through MCP; use fixed safe command templates and app-scoped paths.
- User wants global rclone-sdk installation automatically during installation of the Node.js client library. Important implementation caveat: npm global packages are not normally resolved as project peerDependencies; global npm install may require privileges and lifecycle scripts may be disabled. Investigate clean installer/setup command or regular dependency rather than claiming peer dependency plus global install works automatically. rclone-sdk is only RC client and still needs rclone binary/daemon. No software has been uninstalled yet.
- OneDrive/rclone remote is transit-only; user allows deleting ANY file in the dedicated temporary remote app storage, including unacknowledged uploads, as required by seven-day retention and quota headroom policy. This permission does NOT extend to unrelated files elsewhere in a shared OneDrive account. On server startup delete app-owned remote files older than 7 days; when upload needs space, remove oldest app-owned objects until size + 500 MiB margin available; allow forced eviction within app-owned temporary area. If local source exists, republish on demand. If source gone, report unavailable. Minimize safeguards to path scoping and safe deletion of non-app data, not extensive account checks.
- Keep Firebase user auth and one-server pairing separate from remote storage auth; client MCP requests files by filename using configured remote name, with basic collision/path sanitization only.

### README installation section and rclone CLI decision (2026-11-02)
- User explicitly authorized editing README.md to add near-top 'Installazione e configurazione' with separate Client MCP and Server Tauri subsections and placeholders for additional programs to be determined stepwise. README updated on branch in commit 1a85ecb30e62f05d632ea3979dfe270f4ef82781; AGENTS.md untouched.
- Latest decision supersedes earlier rclone-sdk plan: DO NOT install/use rclone-sdk. Users manually install official rclone CLI on BOTH server and client, run `rclone config` to create provider-agnostic remotes, verify `rclone version` and `rclone listremotes`; no RC daemon required. Client MCP will use configured remote name via rclone CLI. Server Tauri may spawn rclone subprocess. No OneDrive-only assumption.
- Preserve existing rclone config until migration confirmed; never uninstall software without explicit separate execution approval. Client/server remotes may have different local names but must refer to mutually accessible shared folder; no identity correctness preflight. Temporary app folder only is eligible for remote cleanup.

### Cloudflare resources actually provisioned (2026-11-03)
- Cloudflare account: Drincs.contact@gmail.com's Account; account ID `9220f7205f84b31220f9b9ad839d2d72`; existing workers `govd` and `pixi-vn-kofi` were untouched. Account workers.dev subdomain `drincs-contact` (actual script routing/URL not yet independently tested).
- CREATED via Cloudflare API: Worker `shadow-mcp-relay` (script ID), created 2026-11-03T07:04:25Z; deployment ID `30e5ce453e8447678b58fb3177728b83`, compatibility date 2026-11-02, nodejs_compat enabled, standard usage model. Source is a deliberately locked-down bootstrap: GET /health returns JSON {status:'setup',service:'shadow-mcp-relay',firebase:'pending',relay:'not-active'}; all other routes return HTTP 503 not_configured. No secrets or tokens were added. It is NOT a functioning relay and no Shadow WebSocket is connected.
- Durable Object binding/class and SQLite durable mailbox are NOT YET CREATED; they require implementation/deployment of the actual relay class, auth validation, connection ownership, idempotent mailbox, and websocket hibernation. Do not claim they exist. Firebase auth and pairing deliberately postponed by user. Never expose unauthenticated job submission or server connection. Use Workers Free and SQLite-backed DO on Free; avoid paid services and quotas.
- Follow-up tasks: implement source-controlled Worker+DO in repository with Wrangler config, test locally, add DO binding, deploy fail-closed, verify actual workers.dev URL and /health, then later Firebase JWT verification and secure server pairing; no Firebase provisioning now. Keep existing workers untouched.

### Cloudflare deployment pipeline decision (2026-11-03)
- All Cloudflare Worker/Durable Object source code MUST live in this repository, proposed `cloudflare/worker/src/index.ts`, `cloudflare/worker/src/ShadowRelay.ts`, `cloudflare/worker/wrangler.jsonc`, `cloudflare/worker/package.json`. Cloudflare-hosted `shadow-mcp-relay` is the deployment target, not a manually maintained source of truth.
- Add GitHub Actions CI/CD workflow (e.g. `.github/workflows/cloudflare-relay.yml`): on development branch pushes run install/lint/typecheck/tests/build without production deployment; `workflow_dispatch` enables controlled deployment of `shadow-mcp-relay`; after validation, optionally enable automatic production deploy from default branch. Avoid accidental deploys from feature branches.
- Use pinned/maintained Wrangler and official Cloudflare deployment action or Wrangler CLI. GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or nonsecret account ID as variable), least-privilege scoped to Workers deployment; do not commit tokens, Firebase credentials, or rclone configs. Workflow permissions minimum (`contents: read`), concurrency protection, and deployment failure must be visible.
- Durable Object class/binding/SQLite storage configuration and migrations/exports must be version-controlled and deployed together. Preserve fail-closed auth until Firebase integration; do not enable unprotected WebSocket/commands. Existing Cloudflare workers `govd` and `pixi-vn-kofi` remain untouched.
- This is a DESIGN DECISION recorded in handoff, not yet an implemented GitHub Actions workflow; implement during repository coding phase.

### Project scope and runtime prerequisites clarified (2026-11-03)
- Project is a GENERAL extension of Codex's generative capabilities through local AI and external generation programs, minimizing online credit consumption where feasible; NOT a visual-novel-specific product. README title/intro and explicit visual-novel references updated; legacy domain-specific workflow descriptions remain historical context, not a scope restriction.
- Release binaries/installers are built by GitHub CI. End users on Shadow/server do NOT need Rust toolchain, Tauri build tools, Wrangler, or Cloudflare dashboard to install/run the released application. CI needs build toolchains and OS-specific runners. Node.js IS required on both client and server for MCP TypeScript and JS-based AI CLIs/adapters.
- Client requirements: rclone, Node.js, Codex CLI (npm install -g @openai/codex) as MCP client/control entry point.
- Server requirements: rclone, Node.js, LM Studio, Codex CLI (npm install -g @openai/codex) for coordination/control, Gemini CLI (npm install -g @google/gemini-cli) as reviewer/validator. Configure CLI login and respect provider usage limits. Gemini review should be optional at runtime if quota/auth unavailable; deterministic checks remain mandatory.
- GitHub Actions handles both cross-platform application release builds and separate controlled Cloudflare Worker/DO deployment. Existing Cloudflare Worker shadow-mcp-relay remains deployment target, not an end-user installation dependency; Firebase postponed. Neither workflow nor release builds are claimed implemented yet.
- Installation guide uses tables for each machine and bold Configurazioni particolari text directly under each table (not heading).

### Simplified general architecture and coordinator responsibility (2026-11-03)
- User communicates exclusively with Codex CLI on the physical client PC. Codex invokes the local MCP client; the MCP client communicates bidirectionally over WebSocket through the Cloudflare relay to the persistent Rust coordinator on the Shadow/server PC.
- The Rust coordinator, NOT Codex, owns the authoritative SQLite job queue and execution state: enqueue, scheduling, resource/VRAM allocation, retries, cancellation, restart recovery, program dispatch, progress and result reporting. Codex remains conversational front end and request originator; Tauri is a server management GUI.
- The coordinator can dispatch to LM Studio, AI CLIs (Codex/Gemini where configured) and asset generators; artifacts use the separate rclone transport. The relay and persistent queue are planned, not yet implemented.
- README Architecture generale Mermaid diagram was simplified accordingly. Legacy Bionic/Regia/visual-novel worker sections below it remain historical descriptions, not the target architecture; future cleanup should remove or archive obsolete material rather than treating it as requirements.

### Regia removal and cleanup scope (2026-11-03)
- CONFIRMED: the Regia role is fully removed from the target architecture. Codex CLI is the sole user-facing conversational interface; Codex sends MCP/WebSocket requests to the persistent Rust Coordinator, which owns the job queues. There is no Regia handoff, Bionic chat entry point, or Regia approval stage in the target design.
- The obsolete Regia section was removed from README. Remaining historical references in documentation or code are not requirements and should be cleaned up as implementation progresses.
- PLAN FOR LATER CLEANUP (not executed yet): inventory and remove models installed solely for Regia (including the dedicated Regia model/profile if not shared), Bionic Regia profiles and prompts, Regia-specific routes/MCP tools, handoff logic, configuration, scripts, tests, and unused dependencies. Verify references and shared use before deleting any model or component; preserve models and assets required by other workers. Do not delete user files, shared LM Studio models, or change AGENTS.md without explicit approval.
- Document removal candidates and confirm dependency impact before destructive actions. This note authorizes documenting the removal plan, not uninstalling programs or deleting files now.

### Valutazione futura: Gemini rispetto a Qwen3 8B nella review narrativa

Qwen3 8B resta il Narrative Reviewer previsto per lo Scrittore; Gemini non lo sostituisce per ora. Durante i test potremo confrontare i due modelli su scene narrative rappresentative, comprese scene cruente e contenuti NSFW consentiti, per misurare: tasso di rifiuto o blocco, fedeltà al testo originale (senza attenuazioni non richieste), qualità delle osservazioni editoriali, rispetto del SceneContract, tempi e costi di esecuzione. Registrare separatamente i casi di rifiuto e le modifiche indesiderate, senza assumere in anticipo che uno dei modelli sia privo di filtri. Un eventuale passaggio a Gemini richiederà risultati documentati e una decisione esplicita; nessuna modifica operativa è prevista ora.
