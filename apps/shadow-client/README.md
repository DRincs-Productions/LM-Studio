# Shadow Controller client

This Node.js package provides Google sign-in and Firebase enrollment for a client device. It opens the hosted HTTPS Firebase sign-in page, receives the session through a one-time localhost callback restricted to the Firebase portal origin and login state, validates the Google-backed Firebase identity, creates an Ed25519 key pair, registers the public key under the signed-in account's `authorizedClients` collection, and stores the refresh token and private key in the operating system credential store. It also exposes local account-management tools over MCP stdio.

The package also contains an authenticated WebSocket relay client and MCP tools for generic server tasks and narrative requests. `shadow_submit_narration` accepts a chat brief; `shadow_submit_narration_file` reads an explicitly selected file inside the MCP tool so the client model need not inspect its contents before submission. Both enqueue `narrative.generate` v1. Use `shadow_wait_job` or `shadow_job_status`, then `get_narration_result` to download the OneDrive scene, verify its SHA-256 and receive a local path before analysing it. Generic `codex.execute` jobs remain available through `shadow_submit_job`.

For `codex.execute` v1, the client accepts only `{ "task": "..." }`. For `narrative.generate` v1, it validates `projectId`, `projectSha256`, and `brief`, with optional object-valued `metadata`. File submissions are limited to 12,000 UTF-8 bytes. Pass canon text in `metadata.canon` only when it is available and authorized; the hash alone does not let the server read or verify a project revision. A returned `completed_with_warnings` manifest still contains a usable scene when its OneDrive path and hash are present, but reviewer errors are never approval.

## Commands

Install the published package from npm:

```powershell
npm install --global shadow-controller-mcp-client
shadow-client login
shadow-client status
shadow-client logout
shadow-client install-skill
```

The package exposes `shadow-client` for login and account management and `shadow-controller-mcp` for the Codex MCP connection. During package development, run commands from this directory with `npm run start -- <command>` after building.

## Publishing a release

GitHub Actions publishes this package when a `lib-v<version>` tag is pushed. Set the repository Actions secret `NPM_TOKEN` to an npm publish token. Update both `package.json` and `package-lock.json` to the release version, commit and push the changes, then create and push a matching tag. For example, when both manifests contain `0.1.0`:

```powershell
git tag lib-v0.1.0
git push origin lib-v0.1.0
```

The workflow checks that the tag matches the package version, installs dependencies, builds the CLI/MCP server, checks the npm tarball contents, publishes stable versions under `latest` and prereleases under `next`, then creates a GitHub Release. See [`release-lib.yml`](../../.github/workflows/release-lib.yml).

Run `shadow-client install-skill` to install the bundled `shadow-requests` skill into Codex's skills directory. Register the local MCP server in Codex using the installed `shadow-controller-mcp` command. Set `SHADOW_RELAY_URL` in the MCP process environment and as a user environment variable on the paired server to the relay HTTPS base URL. On the server configure `SHADOW_NARRATION_MODEL` to an installed LM Studio model identifier; optionally set `SHADOW_LM_API_BASE_URL` (default `http://127.0.0.1:1234`), `SHADOW_NARRATION_CONTEXT`, `SHADOW_LMS_EXECUTABLE`, `SHADOW_GEMINI_EXECUTABLE`, `SHADOW_CODEX_EXECUTABLE`, and `SHADOW_RCLONE_EXECUTABLE`. For Windows, set Gemini's executable to its bundled `gemini.js` path and Codex's to an executable or Node-compatible `.js` entrypoint. The server user must have working LM Studio, `lms`, Gemini CLI in Auto mode, authenticated Codex CLI, and rclone's `imagecloud:` remote. `shadow_submit_job` with operation `codex.execute` and payload `{ "task": "..." }` queues a generic task. Use the returned requestId/jobId to poll; no automatic resubmission occurs. Run logs, stage records and manifests are kept in the server app data directory. The skill file is bundled at `skills/shadow-requests/SKILL.md`.

`login` signs in and enrolls a new client. `register` retries an interrupted Firestore enrollment. `logout` removes the Firebase client record before deleting local credentials. If revocation fails, the credentials remain in the OS keychain so the operation can be retried; the desktop Security screen can also revoke an existing client.
