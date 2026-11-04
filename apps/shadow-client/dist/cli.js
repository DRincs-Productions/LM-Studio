#!/usr/bin/env node
import {
  clientStatus,
  enrollClient,
  login,
  logout
} from "./chunk-EKQY6ICT.js";

// src/cli.ts
async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "login") {
    const client = await login();
    console.log(`Signed in as ${client.email}. Client ${client.clientId} is authorized.`);
    return;
  }
  if (command === "register") {
    const client = await enrollClient();
    console.log(`Client ${client.clientId} is authorized as ${client.displayName}.`);
    return;
  }
  if (command === "status") {
    const client = await clientStatus();
    if (!client) {
      console.log("No client is signed in. Run `shadow-client login`.");
      return;
    }
    console.log(JSON.stringify({ signedIn: true, email: client.email, clientId: client.clientId, registered: client.registered }, null, 2));
    return;
  }
  if (command === "logout") {
    await logout();
    console.log("Client authorization revoked and local credentials removed.");
    return;
  }
  console.log("Shadow Controller client commands:\n  shadow-client login\n  shadow-client register\n  shadow-client status\n  shadow-client logout");
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Shadow client command failed.");
  process.exitCode = 1;
});
