# Shadow Controller Desktop

The Tauri + React desktop application is the configuration and monitoring surface for the persistent Shadow Coordinator. The Coordinator owns job scheduling and continues independently of this window.

The Overview, Engines, Storage and Security screens remain setup placeholders. The Jobs screen is connected to the local SQLite store through Tauri commands: it can list queued jobs, add a clearly marked local queue entry, and cancel it. Queue entries are persisted on this device and do not dispatch work or invoke models. Authentication, server pairing, execution workers, live remote status and engine configuration are not connected yet; remote access remains disabled.

## Development

```powershell
npm install
npm run dev
```

Building or running the native Tauri application requires the platform prerequisites, including Rust. GitHub Actions will provide the release builds so end users do not need the Rust toolchain.
