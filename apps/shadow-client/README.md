# Shadow Controller client

This Node.js package provides Google sign-in and Firebase enrollment for a client device. It opens the system browser, validates the Google-backed Firebase identity, creates an Ed25519 key pair, registers the public key under the signed-in account's `authorizedClients` collection, and stores the refresh token and private key in the operating system credential store. It also exposes local account-management tools over MCP stdio.

The package also contains an authenticated WebSocket relay client and MCP tools for submit, status, list, cancel, explicit retry and asset metadata. They require a deployed relay and an outbound server connection; neither has passed live verification yet.

## Commands

```powershell
npx --yes --package shadow-controller-mcp-client shadow-client login
npx --yes --package shadow-controller-mcp-client shadow-client status
npx --yes --package shadow-controller-mcp-client shadow-client logout
```

During repository development, run the same commands from this directory with `npm run start -- <command>` after building.

Register the local MCP server in Codex with command `node` and argument `C:\\path\\to\\apps\\shadow-client\\dist\\server.js`. Set `SHADOW_RELAY_URL` in the MCP process environment and as a user environment variable on the paired server to the relay HTTPS base URL before using remote tools. The server Coordinator receives remote queue requests, status, list and cancellation through its outbound WSS connection. Queue submission persists work locally but does not dispatch production workers yet; manual retry and asset tools are not implemented server-side.

`login` signs in and enrolls a new client. `register` retries an interrupted Firestore enrollment. `logout` removes the Firebase client record before deleting local credentials. If revocation fails, the credentials remain in the OS keychain so the operation can be retried; the desktop Security screen can also revoke an existing client.
