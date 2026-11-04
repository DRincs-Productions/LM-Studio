import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import { clientStatus, enrollClient, getClientIdToken, login, logout } from "./auth.js";
import { callRelay, relayStatus, type RelayMessage } from "./relay-client.js";

function createServer(): McpServer {
  const server = new McpServer({ name: "shadow-controller", version: "0.1.0" });

  server.registerTool("shadow_login", {
    description: "Sign this client into the Shadow Controller account and enroll its public key.",
    inputSchema: z.object({}),
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
    inputSchema: z.object({}),
  }, async () => {
    try {
      const client = await clientStatus();
      return { content: [{ type: "text", text: client
        ? JSON.stringify({ signedIn: true, email: client.email, clientId: client.clientId, registered: client.registered })
        : JSON.stringify({ signedIn: false }) }] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("shadow_register_client", {
    description: "Retry registration of this local client's public key in Firebase.",
    inputSchema: z.object({}),
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
    inputSchema: z.object({}),
  }, async () => {
    try {
      await logout();
      return { content: [{ type: "text", text: "Client authorization revoked and local credentials removed." }] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("shadow_auth_token_status", {
    description: "Check that Firebase can refresh this enrolled client's identity token. This does not verify relay connectivity.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      await getClientIdToken();
      return { content: [{ type: "text", text: "Firebase identity token refreshed for the enrolled client. Use shadow_relay_status to verify the server connection." }] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("shadow_relay_status", {
    description: "Verify that this enrolled client can authenticate to the relay and that the paired server is online.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      await relayStatus();
      return { content: [{ type: "text", text: "Client authenticated to the relay and the paired server is online." }] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("shadow_submit_job", {
    description: "Submit one generation or production request to the paired Shadow server. Returns a requestId for status recovery; never resubmits automatically.",
    inputSchema: z.object({
      operation: z.string().min(1).max(100),
      payload: z.record(z.string(), z.json()),
      payloadVersion: z.number().int().min(1).default(1),
      requestId: z.string().uuid().optional(),
    }),
  }, async ({ operation, payload, payloadVersion, requestId }) => {
    const stableRequestId = requestId ?? randomUUID();
    try {
      const response = await callRelay({
        version: 1,
        type: "job.submit",
        messageId: randomUUID(),
        requestId: stableRequestId,
        payloadVersion,
        payload: { operation, params: payload },
      });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      return jsonResult({ requestId: stableRequestId, response });
    } catch (error) {
      return errorResult(new Error(`${errorMessage(error)} Request ID: ${stableRequestId}. Query this ID before submitting again.`));
    }
  });

  server.registerTool("shadow_job_status", {
    description: "Query a job by jobId or stable requestId after a submit, disconnect or client restart.",
    inputSchema: z.object({
      jobId: z.string().uuid().optional(),
      requestId: z.string().uuid().optional(),
    }).refine((input) => Boolean(input.jobId || input.requestId), "Provide jobId or requestId."),
  }, async ({ jobId, requestId }) => relayToolCall({ version: 1, type: "job.status", messageId: randomUUID(), ...(jobId ? { jobId } : {}), ...(requestId ? { requestId } : {}) }));

  server.registerTool("shadow_list_jobs", {
    description: "List recent jobs submitted to the paired Shadow server.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  }, async ({ limit }) => relayToolCall({ version: 1, type: "job.list", messageId: randomUUID(), ...(limit ? { limit } : {}) }));

  server.registerTool("shadow_cancel_job", {
    description: "Request cancellation of a queued or running job. A running job is cancelled only after the server confirms it.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async ({ jobId }) => relayToolCall({ version: 1, type: "job.cancel", messageId: randomUUID(), jobId }));

  server.registerTool("shadow_retry_job", {
    description: "Manually request a new attempt for a failed job. This is explicit and never runs automatically.",
    inputSchema: z.object({ jobId: z.string().uuid(), reason: z.string().max(500).optional() }),
  }, async ({ jobId, reason }) => relayToolCall({ version: 1, type: "job.retry", messageId: randomUUID(), jobId, ...(reason ? { reason } : {}) }));

  server.registerTool("shadow_list_assets", {
    description: "List asset metadata and manifests available from completed jobs. Large files are not transferred through the relay.",
    inputSchema: z.object({ jobId: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).optional() }),
  }, async ({ jobId, limit }) => relayToolCall({ version: 1, type: "asset.list", messageId: randomUUID(), ...(jobId ? { jobId } : {}), ...(limit ? { limit } : {}) }));

  server.registerTool("shadow_get_asset", {
    description: "Get metadata or a download reference for an asset. Binary content is not relayed through this connection.",
    inputSchema: z.object({ assetId: z.string().min(1).max(256) }),
  }, async ({ assetId }) => relayToolCall({ version: 1, type: "asset.get", messageId: randomUUID(), assetId }));

  return server;
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Shadow Controller client operation failed." }],
    isError: true,
  };
}

async function relayToolCall(message: RelayMessage) {
  try {
    const response = await callRelay(message);
    if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
    return jsonResult(response);
  } catch (error) {
    return errorResult(error);
  }
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    const code = "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
    const manualRetry = "retryable" in error && error.retryable === true ? " A manual retry may be requested." : "";
    return `${code}${error.message}${manualRetry}`;
  }
  return error instanceof Error ? error.message : "Relay request failed.";
}

void serveStdio(createServer);
