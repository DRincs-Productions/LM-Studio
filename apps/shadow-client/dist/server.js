import {
  clientStatus,
  enrollClient,
  getClientIdToken,
  login,
  logout,
  readCredential
} from "./chunk-EKQY6ICT.js";

// src/server.ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { randomUUID } from "crypto";

// src/relay-client.ts
import { sign } from "crypto";
import WebSocket from "ws";
var MAX_MESSAGE_BYTES = 64 * 1024;
var DEFAULT_TIMEOUT_MS = 3e4;
var MESSAGE_QUEUES = /* @__PURE__ */ new WeakMap();
async function relayStatus() {
  return withRelay(async (_socket, ready) => {
    if (ready.serverOnline !== true) throw new Error("Client is authenticated, but the paired server is offline.");
  });
}
async function callRelay(message, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const messageId = message.messageId;
  if (!messageId) throw new Error("Relay request is missing a messageId.");
  return withRelay(async (socket) => {
    const reply = waitForMessage(socket, (candidate) => candidate.replyTo === messageId && candidate.type !== "job.progress", timeoutMs);
    sendJson(socket, message);
    return reply;
  });
}
async function withRelay(operation) {
  const credential = readCredential();
  if (!credential) throw new Error("Sign in first with `shadow-client login`.");
  if (!credential.registered) throw new Error("Client enrollment is incomplete. Run `shadow-client register`.");
  const relayBase = process.env.SHADOW_RELAY_URL;
  if (!relayBase) throw new Error("Set SHADOW_RELAY_URL to the relay HTTPS URL before connecting.");
  const url = new URL(relayBase);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("SHADOW_RELAY_URL must use HTTPS/WSS (or local HTTP/WS during development).");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/connect`;
  url.search = new URLSearchParams({ role: "client", clientId: credential.clientId }).toString();
  const idToken = await getClientIdToken();
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false
  });
  socket.on("error", () => void 0);
  MESSAGE_QUEUES.set(socket, new MessageInbox(socket));
  try {
    await waitForOpen(socket);
    const challenge = await waitForMessage(socket, (message) => message.type === "relay.challenge" || message.type === "relay.ready");
    let ready = challenge;
    if (challenge.type === "relay.challenge") {
      if (typeof challenge.challenge !== "string") throw new Error("Relay sent an invalid authentication challenge.");
      const nonce = Buffer.from(challenge.challenge, "base64url");
      const signature = sign(null, nonce, credential.privateKey).toString("base64url");
      sendJson(socket, { version: 1, type: "auth.proof", challenge: challenge.challenge, signature });
      ready = await waitForMessage(socket, (message) => message.type === "relay.ready", 1e4);
      if (ready.type !== "relay.ready") throw new Error("Relay client authentication failed.");
    }
    return await operation(socket, ready);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Relay request timed out")) throw error;
    throw normalizeRelayError(error);
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1e3, "Request complete");
  }
}
function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Relay connection timed out.")), 15e3);
    const onOpen = () => finish();
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("Relay closed the connection before authentication."));
    function finish(error) {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
function waitForMessage(socket, predicate, timeoutMs = 1e4) {
  const inbox = MESSAGE_QUEUES.get(socket);
  if (!inbox) return Promise.reject(new Error("Relay message listener is unavailable."));
  return inbox.wait(predicate, timeoutMs);
}
function sendJson(socket, message) {
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new Error("Relay request exceeds the 64 KiB message limit.");
  socket.send(body);
}
function errorText(message) {
  const error = message.error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Relay rejected the request.";
}
function normalizeRelayError(error) {
  if (error instanceof Error) return error;
  return new Error("Relay connection failed.");
}
var MessageInbox = class {
  messages = [];
  waiters = /* @__PURE__ */ new Set();
  constructor(socket) {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return this.failAll(new Error("Relay returned an unexpected binary message."));
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return this.failAll(new Error("Relay returned an invalid JSON message."));
      }
      if (message.type === "error" && message.replyTo === void 0) {
        return this.failAll(new Error(errorText(message)));
      }
      const waiter = [...this.waiters].find((entry) => entry.predicate(message));
      if (waiter) this.resolve(waiter, message);
      else {
        this.messages.push(message);
        if (this.messages.length > 32) this.messages.shift();
      }
    });
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", (code, reason) => {
      this.failAll(new Error(`Relay closed the connection (${code}): ${reason.toString()}`));
    });
  }
  wait(predicate, timeoutMs) {
    const queuedIndex = this.messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Relay request timed out after ${timeoutMs} ms.`));
        }, timeoutMs)
      };
      this.waiters.add(waiter);
    });
  }
  resolve(waiter, message) {
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
  failAll(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
};

// src/server.ts
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
  server.registerTool("shadow_relay_status", {
    description: "Verify that this enrolled client can authenticate to the relay and that the paired server is online.",
    inputSchema: z.object({})
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
      requestId: z.string().uuid().optional()
    })
  }, async ({ operation, payload, payloadVersion, requestId }) => {
    const stableRequestId = requestId ?? randomUUID();
    try {
      const response = await callRelay({
        version: 1,
        type: "job.submit",
        messageId: randomUUID(),
        requestId: stableRequestId,
        payloadVersion,
        payload: { operation, params: payload }
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
      requestId: z.string().uuid().optional()
    }).refine((input) => Boolean(input.jobId || input.requestId), "Provide jobId or requestId.")
  }, async ({ jobId, requestId }) => relayToolCall({ version: 1, type: "job.status", messageId: randomUUID(), ...jobId ? { jobId } : {}, ...requestId ? { requestId } : {} }));
  server.registerTool("shadow_list_jobs", {
    description: "List recent jobs submitted to the paired Shadow server.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() })
  }, async ({ limit }) => relayToolCall({ version: 1, type: "job.list", messageId: randomUUID(), ...limit ? { limit } : {} }));
  server.registerTool("shadow_cancel_job", {
    description: "Request cancellation of a queued or running job. A running job is cancelled only after the server confirms it.",
    inputSchema: z.object({ jobId: z.string().uuid() })
  }, async ({ jobId }) => relayToolCall({ version: 1, type: "job.cancel", messageId: randomUUID(), jobId }));
  server.registerTool("shadow_retry_job", {
    description: "Manually request a new attempt for a failed job. This is explicit and never runs automatically.",
    inputSchema: z.object({ jobId: z.string().uuid(), reason: z.string().max(500).optional() })
  }, async ({ jobId, reason }) => relayToolCall({ version: 1, type: "job.retry", messageId: randomUUID(), jobId, ...reason ? { reason } : {} }));
  server.registerTool("shadow_list_assets", {
    description: "List asset metadata and manifests available from completed jobs. Large files are not transferred through the relay.",
    inputSchema: z.object({ jobId: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).optional() })
  }, async ({ jobId, limit }) => relayToolCall({ version: 1, type: "asset.list", messageId: randomUUID(), ...jobId ? { jobId } : {}, ...limit ? { limit } : {} }));
  server.registerTool("shadow_get_asset", {
    description: "Get metadata or a download reference for an asset. Binary content is not relayed through this connection.",
    inputSchema: z.object({ assetId: z.string().min(1).max(256) })
  }, async ({ assetId }) => relayToolCall({ version: 1, type: "asset.get", messageId: randomUUID(), assetId }));
  return server;
}
function errorResult(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : "Shadow Controller client operation failed." }],
    isError: true
  };
}
async function relayToolCall(message) {
  try {
    const response = await callRelay(message);
    if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
    return jsonResult(response);
  } catch (error) {
    return errorResult(error);
  }
}
function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function errorMessage(error) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    const code = "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
    const manualRetry = "retryable" in error && error.retryable === true ? " A manual retry may be requested." : "";
    return `${code}${error.message}${manualRetry}`;
  }
  return error instanceof Error ? error.message : "Relay request failed.";
}
void serveStdio(createServer);
