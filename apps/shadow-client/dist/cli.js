#!/usr/bin/env node
import {
  clientStatus,
  enrollClient,
  login,
  logout
} from "./chunk-T3RSEUCF.js";

// src/cli.ts
import { copyFile, mkdir, readFile } from "fs/promises";
import { constants } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
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
  if (command === "install-skill") {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const destination = join(codexHome, "skills", "shadow-requests", "SKILL.md");
    const source = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "shadow-requests", "SKILL.md");
    await mkdir(dirname(destination), { recursive: true });
    try {
      const installed = await readFile(destination, "utf8");
      const bundled = await readFile(source, "utf8");
      if (installed !== bundled) throw new Error(`An existing Shadow Requests skill differs and was preserved: ${destination}`);
      console.log(`Shadow Requests is already installed at ${destination}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("An existing Shadow Requests skill")) throw error;
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      console.log(`Installed Shadow Requests at ${destination}`);
    }
    return;
  }
  console.log("Shadow Controller client commands:\n  shadow-client install-skill\n  shadow-client login\n  shadow-client register\n  shadow-client status\n  shadow-client logout");
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Shadow client command failed.");
  process.exitCode = 1;
});
