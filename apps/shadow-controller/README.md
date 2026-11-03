# Shadow Controller Desktop

The Tauri + React desktop application is the configuration and monitoring surface for the persistent Shadow Coordinator. The Coordinator owns job scheduling and continues independently of this window.

The current screen is an initial UI shell. Authentication, server pairing, live status, job history and engine configuration remain in implementation; the displayed setup states are not connected to a backend yet.

## Development

```powershell
npm install
npm run dev
```

Building or running the native Tauri application requires the platform prerequisites, including Rust. GitHub Actions will provide the release builds so end users do not need the Rust toolchain.
