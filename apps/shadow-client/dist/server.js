import {
  clientStatus,
  enrollClient,
  getClientIdToken,
  login,
  logout,
  readCredential
} from "./chunk-HM2DCZCK.js";

// src/server.ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { promisify } from "util";

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
var narrativePayload = z.object({
  projectId: z.string().uuid(),
  projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  brief: z.string().trim().min(1).max(12e3),
  metadata: z.record(z.string(), z.json()).optional()
});
var codexPayload = z.object({ task: z.string().trim().min(1).max(12e3) }).strict();
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
    description: "Check that Firebase can refresh this enrolled client's identity token. This does not verify relay connectivity.",
    inputSchema: z.object({})
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
    description: "Submit a generic task to server-side Codex, or a narrative.generate v1 request to the server narration queue. Then use shadow_wait_job or shadow_job_status with the returned requestId. Never resubmits automatically.",
    inputSchema: z.object({
      operation: z.string().min(1).max(100),
      payload: z.record(z.string(), z.json()),
      payloadVersion: z.number().int().min(1).default(1),
      requestId: z.string().uuid().optional()
    })
  }, async ({ operation, payload, payloadVersion, requestId }) => {
    const stableRequestId = requestId ?? randomUUID();
    if (operation === "narrative.generate") {
      if (payloadVersion !== 1) return errorResult(new Error("Narration requires payload version 1."));
      const validated = narrativePayload.safeParse(payload);
      if (!validated.success) return errorResult(new Error(z.prettifyError(validated.error)));
      payload = validated.data;
    }
    if (operation === "codex.execute") {
      const validated = codexPayload.safeParse(payload);
      if (!validated.success) return errorResult(new Error(z.prettifyError(validated.error)));
      payload = validated.data;
    }
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
  const narrationInput = z.object({
    projectId: z.string().uuid(),
    projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: z.record(z.string(), z.json()).optional(),
    requestId: z.string().uuid().optional()
  });
  const submitNarration = async (brief, values) => {
    if (Buffer.byteLength(brief, "utf8") > 12e3) return errorResult(new Error("Narration briefs are limited to 12,000 UTF-8 bytes."));
    const stableRequestId = values.requestId ?? randomUUID();
    const payload = narrativePayload.parse({
      projectId: values.projectId,
      projectSha256: values.projectSha256,
      brief,
      ...values.metadata ? { metadata: values.metadata } : {}
    });
    try {
      const response = await callRelay({
        version: 1,
        type: "job.submit",
        messageId: randomUUID(),
        requestId: stableRequestId,
        payloadVersion: 1,
        payload: { operation: "narrative.generate", params: payload }
      });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      return jsonResult({ requestId: stableRequestId, response });
    } catch (error) {
      return errorResult(new Error(`${errorMessage(error)} Request ID: ${stableRequestId}. Query this ID before submitting again.`));
    }
  };
  server.registerTool("shadow_submit_narration", {
    description: "Queue an English scene request for the paired Shadow server. The server runs the Writer, Gemini review, Codex final check, then publishes the result to OneDrive. Use shadow_wait_job, then get_narration_result before analysing the returned scene.",
    inputSchema: narrationInput.extend({ brief: z.string().trim().min(1).max(12e3) })
  }, async ({ brief, ...values }) => submitNarration(brief, values));
  server.registerTool("shadow_submit_narration_file", {
    description: "Read the explicitly selected local Markdown/text request inside this MCP tool and queue its contents for server narration without returning or analysing the file contents in chat. Use shadow_wait_job, then get_narration_result before analysing the returned scene.",
    inputSchema: narrationInput.extend({ filePath: z.string().trim().min(1).max(2048) })
  }, async ({ filePath, ...values }) => {
    try {
      const bytes = await readFile(filePath);
      if (!bytes.length || bytes.length > 12e3) return errorResult(new Error("Narration request files must contain 1\u201312,000 bytes."));
      const brief = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (!brief) return errorResult(new Error("The selected narration request file is empty."));
      return submitNarration(brief, values);
    } catch (error) {
      return errorResult(new Error(`Could not submit the selected narration file: ${errorMessage(error)}`));
    }
  });
  server.registerTool("shadow_job_status", {
    description: "Query a job by jobId or stable requestId after a submit, disconnect or client restart.",
    inputSchema: z.object({
      jobId: z.string().uuid().optional(),
      requestId: z.string().uuid().optional()
    }).refine((input) => Boolean(input.jobId || input.requestId), "Provide jobId or requestId.")
  }, async ({ jobId, requestId }) => relayToolCall({ version: 1, type: "job.status", messageId: randomUUID(), ...jobId ? { jobId } : {}, ...requestId ? { requestId } : {} }));
  server.registerTool("get_narration_result", {
    description: "Download the narrative referenced by an authenticated job status, verify its SHA-256 and return its local path for analysis.",
    inputSchema: z.object({ jobId: z.string().uuid() })
  }, async ({ jobId }) => {
    try {
      const response = await callRelay({ version: 1, type: "job.status", messageId: randomUUID(), jobId });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      const source = `imagecloud:NarrationWorker/final/${jobId}/scene.md`;
      const job = z.object({
        jobId: z.literal(jobId),
        state: z.enum(["succeeded", "failed"]),
        resultManifest: z.object({
          narrativeRemotePath: z.literal(source),
          narrativeSha256: z.string().regex(/^[a-f0-9]{64}$/)
        })
      }).parse(response.job);
      const { stdout } = await promisify(execFile)("rclone", ["cat", source], {
        encoding: "buffer",
        timeout: 12e4,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      });
      const sha256 = createHash("sha256").update(stdout).digest("hex");
      if (!stdout.length || sha256 !== job.resultManifest.narrativeSha256) {
        return errorResult(new Error("Narrative download failed integrity verification."));
      }
      const root = join(homedir(), ".shadow-controller", "narration");
      await mkdir(root, { recursive: true });
      const localPath = join(await mkdtemp(join(root, `${jobId}-`)), "scene.md");
      await writeFile(localPath, stdout, { flag: "wx" });
      return jsonResult({ jobId, localPath, sha256, bytes: stdout.length });
    } catch {
      return errorResult(new Error("No downloadable narrative could be verified for this job."));
    }
  });
  server.registerTool("shadow_wait_job", {
    description: "Wait for a queued or running server job to finish and return its result manifest, including narrative file reference and stage outcomes when applicable. This only polls status; it never submits or retries work.",
    inputSchema: z.object({
      jobId: z.string().uuid().optional(),
      requestId: z.string().uuid().optional(),
      timeoutSeconds: z.number().int().min(5).max(5400).default(5400)
    }).refine((input) => Boolean(input.jobId || input.requestId), "Provide jobId or requestId.")
  }, async ({ jobId, requestId, timeoutSeconds }) => {
    const deadline = Date.now() + timeoutSeconds * 1e3;
    while (Date.now() < deadline) {
      try {
        const response = await callRelay({ version: 1, type: "job.status", messageId: randomUUID(), ...jobId ? { jobId } : {}, ...requestId ? { requestId } : {} });
        if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
        const state = response.job && typeof response.job === "object" && "state" in response.job ? response.job.state : void 0;
        if (typeof state !== "string") return errorResult(new Error("The relay returned no job state. Check the job with shadow_job_status; it was not resubmitted."));
        if (["succeeded", "failed", "cancelled", "interrupted"].includes(state)) return jsonResult(response);
      } catch (error) {
        return errorResult(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    return errorResult(new Error(`Timed out waiting for job. Query it with shadow_job_status using the same ${jobId ? "jobId" : "requestId"}; it was not resubmitted.`));
  });
  server.registerTool("shadow_list_jobs", {
    description: "List recent jobs submitted to the paired Shadow server.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() })
  }, async ({ limit }) => relayToolCall({ version: 1, type: "job.list", messageId: randomUUID(), ...limit ? { limit } : {} }));
  server.registerTool("shadow_cancel_job", {
    description: "Request cancellation of a queued or running job. A running job is cancelled only after the server confirms it.",
    inputSchema: z.object({ jobId: z.string().uuid() })
  }, async ({ jobId }) => relayToolCall({ version: 1, type: "job.cancel", messageId: randomUUID(), jobId }));
  server.registerTool("shadow_retry_job", {
    description: "Manually queue a new run for a failed job. Never used automatically. Supply retryRequestId to safely check or repeat an uncertain manual request.",
    inputSchema: z.object({ jobId: z.string().uuid(), retryRequestId: z.string().uuid().optional() })
  }, async ({ jobId, retryRequestId }) => {
    const stableRetryRequestId = retryRequestId ?? randomUUID();
    try {
      const response = await callRelay({
        version: 1,
        type: "job.retry",
        messageId: randomUUID(),
        jobId,
        retryRequestId: stableRetryRequestId
      });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      return jsonResult(response);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Relay request failed.";
      return errorResult(new Error(`Manual retry outcome is uncertain. Check shadow_job_status with requestId ${stableRetryRequestId} before requesting another retry. ${detail}`));
    }
  });
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
