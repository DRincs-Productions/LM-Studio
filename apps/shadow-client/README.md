# Shadow Controller client

This Node.js package provides Google sign-in and Firebase enrollment for a client device. It opens the system browser, validates the Google-backed Firebase identity, creates an Ed25519 key pair, registers the public key under the signed-in account's `authorizedClients` collection, and stores the refresh token and private key in the operating system credential store. It also exposes local account-management tools over MCP stdio.

The remote relay transport and job tools are not implemented yet. The current MCP tools cover only local sign-in, enrollment, status and logout, plus Firebase token refresh; they cannot submit or inspect work on the server.

## Commands

```powershell
npx --yes --package shadow-controller-mcp-client shadow-client login
npx --yes --package shadow-controller-mcp-client shadow-client status
npx --yes --package shadow-controller-mcp-client shadow-client logout
```

During repository development, run the same commands from this directory with `npm run start -- <command>` after building.

Register the local MCP server in Codex with command `node` and argument `C:\\path\\to\\apps\\shadow-client\\dist\\server.js`. The relay is not connected yet.

`login` signs in and enrolls a new client. `register` retries an interrupted Firestore enrollment. `logout` removes the Firebase client record before deleting local credentials. If revocation fails, the credentials remain in the OS keychain so the operation can be retried; the desktop Security screen can also revoke an existing client.
