# Shadow Controller Desktop

The Tauri + React desktop application is the configuration and monitoring surface for the persistent Shadow Coordinator. On Windows, it starts the Coordinator as a separate headless process, registers it for user-login autostart in release builds, and can request a controlled stop. A single-instance file lock protects the process; closing the GUI does not stop it.

The Overview, Engines, Storage and Security screens remain setup placeholders. Google sign-in runs in the system browser through a temporary loopback callback; Firebase identity is checked before the refresh credential is stored in the operating system credential store. The sign-in flow has not yet been interactively verified on Windows. The sidebar reports the background process state and can start or stop the Coordinator. The Jobs screen is connected to the local SQLite store through Tauri commands: it can list queued jobs, inspect redacted event history, add a clearly marked local queue entry, and cancel it. Queue entries are persisted on this device and do not dispatch work or invoke models. Server pairing, production execution workers, live remote status and engine configuration are not connected yet; remote access remains disabled. Other operating systems remain unverified.

## Development

```powershell
npm install
npm run dev
```

Building or running the native Tauri application requires the platform prerequisites, including Rust. GitHub Actions will provide the release builds so end users do not need the Rust toolchain.
