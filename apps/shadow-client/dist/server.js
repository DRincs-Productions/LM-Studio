import {
  clientStatus,
  enrollClient,
  getClientIdToken,
  login,
  logout
} from "./chunk-UABE6COZ.js";

// src/server.ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
function createServer() {
  const server = new McpServer({ name: "shadow-controller", version: "0.1.0" });
  server.registerTool("shadow_login", {
    description: "Sign this client into the Shadow Controller account and enroll its public key.",
    inputSchema: z.object({})
  }, async () => {
    try {
      const client = await login();
      return { content: [{ type: "text", text: `Signed in as ${client.email}; client ${client.clientId} is authorized.` }] };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("shadow_client_status", {
    description: "Show whether this local client is signed in and enrolled.",
    inputSchema: z.object({})
  }, async () => {
    try {
      const client = await clientStatus();
      return { content: [{ type: "text", text: client ? JSON.stringify({ signedIn: true, email: client.email, clientId: client.clientId, registered: client.registered }) : JSON.stringify({ signedIn: false }) }] };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("shadow_register_client", {
    description: "Retry registration of this local client's public key in Firebase.",
    inputSchema: z.object({})
  }, async () => {
    try {
      const client = await enrollClient();
      return { content: [{ type: "text", text: `Client ${client.clientId} is enrolled.` }] };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("shadow_logout", {
    description: "Revoke this client in Firebase and remove local credentials.",
    inputSchema: z.object({})
  }, async () => {
    try {
      await logout();
      return { content: [{ type: "text", text: "Client authorization revoked and local credentials removed." }] };
    } catch (error) {
      return errorResult(error);
    }
  });
  server.registerTool("shadow_auth_token_status", {
    description: "Check that Firebase can refresh this enrolled client's identity token. Does not connect to the relay.",
    inputSchema: z.object({})
  }, async () => {
    try {
      await getClientIdToken();
      return { content: [{ type: "text", text: "Firebase identity token refreshed for the enrolled client. Relay transport is not available yet." }] };
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}
function errorResult(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : "Shadow Controller client operation failed." }],
    isError: true
  };
}
void serveStdio(createServer);
