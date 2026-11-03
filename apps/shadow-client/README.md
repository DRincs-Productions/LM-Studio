# Shadow Controller client

This Node.js package provides Google sign-in and Firebase enrollment for a client device. It opens the system browser, validates the Google-backed Firebase identity, creates an Ed25519 key pair, registers the public key under the signed-in account's `authorizedClients` collection, and stores the refresh token and private key in the operating system credential store.

The relay transport and MCP tools are not implemented yet. This package currently prepares a client identity for the later authenticated MCP connection.

## Commands

```powershell
npx shadow-controller-mcp-client login
npx shadow-controller-mcp-client status
npx shadow-controller-mcp-client logout
```

During repository development, run the same commands from this directory with `npm run start -- <command>` after building.

`login` signs in and enrolls a new client. `register` retries an interrupted Firestore enrollment. `logout` removes the Firebase client record before deleting local credentials. If revocation fails, the credentials remain in the OS keychain so the operation can be retried; the desktop Security screen can also revoke an existing client.
