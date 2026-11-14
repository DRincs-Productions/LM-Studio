#!/usr/bin/env node
import { clientStatus, enrollClient, login, logout } from "./auth.js";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
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
    const files = [
      ["shadow-requests", "SKILL.md"],
      ["shadow-image-requests", "SKILL.md"],
      ["shadow-image-requests", "references", "redcraft-v3.md"],
      ["shadow-image-requests", "references", "loras.md"],
    ];
    const selectedSkill = process.argv[3];
    if (selectedSkill && !files.some(([skill]) => skill === selectedSkill)) {
      throw new Error(`Unknown bundled skill: ${selectedSkill}`);
    }
    for (const [skill, ...file] of files) {
      if (selectedSkill && selectedSkill !== skill) continue;
      const destination = join(codexHome, "skills", skill, ...file);
      const source = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", skill, ...file);
      await mkdir(dirname(destination), { recursive: true });
      try {
        const installed = await readFile(destination, "utf8");
        const bundled = await readFile(source, "utf8");
        if (installed !== bundled) throw new Error(`An existing bundled skill differs and was preserved: ${destination}`);
        console.log(`${skill} is already installed at ${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        console.log(`Installed ${skill} at ${destination}`);
      }
    }
    return;
  }
  console.log("Shadow Controller client commands:\n  shadow-client install-skill [skill-name]\n  shadow-client login\n  shadow-client register\n  shadow-client status\n  shadow-client logout");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Shadow client command failed.");
  process.exitCode = 1;
});
