import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { clientStatus, enrollClient, getClientIdToken, login, logout } from "./auth.js";
import { callRelay, relayStatus, type RelayMessage } from "./relay-client.js";

const narrativePayload = z.object({
  projectId: z.string().uuid(),
  projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  brief: z.string().trim().min(1).max(12000),
  metadata: z.record(z.string(), z.json()).optional(),
});
const codexPayload = z.object({ task: z.string().trim().min(1).max(12000) }).strict();

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
    description: "Submit a generic task to server-side Codex, or a narrative.generate v1 request to the server narration queue. Then use shadow_wait_job or shadow_job_status with the returned requestId. Never resubmits automatically.",
    inputSchema: z.object({
      operation: z.string().min(1).max(100),
      payload: z.record(z.string(), z.json()),
      payloadVersion: z.number().int().min(1).default(1),
      requestId: z.string().uuid().optional(),
    }),
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
        payload: { operation, params: payload },
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
    requestId: z.string().uuid().optional(),
  });
  const submitNarration = async (brief: string, values: z.infer<typeof narrationInput>) => {
    if (Buffer.byteLength(brief, "utf8") > 12000) return errorResult(new Error("Narration briefs are limited to 12,000 UTF-8 bytes."));
    const stableRequestId = values.requestId ?? randomUUID();
    const payload = narrativePayload.parse({
      projectId: values.projectId,
      projectSha256: values.projectSha256,
      brief,
      ...(values.metadata ? { metadata: values.metadata } : {}),
    });
    try {
      const response = await callRelay({
        version: 1, type: "job.submit", messageId: randomUUID(), requestId: stableRequestId,
        payloadVersion: 1, payload: { operation: "narrative.generate", params: payload },
      });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      return jsonResult({ requestId: stableRequestId, response });
    } catch (error) {
      return errorResult(new Error(`${errorMessage(error)} Request ID: ${stableRequestId}. Query this ID before submitting again.`));
    }
  };

  server.registerTool("shadow_submit_narration", {
    description: "Queue an English scene request for the paired Shadow server. The server runs the Writer, Gemini review, Codex final check, then publishes the result to OneDrive. Use shadow_wait_job, then get_narration_result before analysing the returned scene.",
    inputSchema: narrationInput.extend({ brief: z.string().trim().min(1).max(12000) }),
  }, async ({ brief, ...values }) => submitNarration(brief, values));

  server.registerTool("shadow_submit_narration_file", {
    description: "Read the explicitly selected local Markdown/text request inside this MCP tool and queue its contents for server narration without returning or analysing the file contents in chat. Use shadow_wait_job, then get_narration_result before analysing the returned scene.",
    inputSchema: narrationInput.extend({ filePath: z.string().trim().min(1).max(2048) }),
  }, async ({ filePath, ...values }) => {
    try {
      const bytes = await readFile(filePath);
      if (!bytes.length || bytes.length > 12000) return errorResult(new Error("Narration request files must contain 1–12,000 bytes."));
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
      requestId: z.string().uuid().optional(),
    }).refine((input) => Boolean(input.jobId || input.requestId), "Provide jobId or requestId."),
  }, async ({ jobId, requestId }) => relayToolCall({ version: 1, type: "job.status", messageId: randomUUID(), ...(jobId ? { jobId } : {}), ...(requestId ? { requestId } : {}) }));

  server.registerTool("get_narration_result", {
    description: "Download the narrative referenced by an authenticated job status, verify its SHA-256 and return its local path for analysis.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
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
          narrativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      }).parse(response.job);
      const { stdout } = await promisify(execFile)("rclone", ["cat", source], {
        encoding: "buffer", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
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
      timeoutSeconds: z.number().int().min(5).max(5400).default(5400),
    }).refine((input) => Boolean(input.jobId || input.requestId), "Provide jobId or requestId."),
  }, async ({ jobId, requestId, timeoutSeconds }) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      try {
        const response = await callRelay({ version: 1, type: "job.status", messageId: randomUUID(), ...(jobId ? { jobId } : {}), ...(requestId ? { requestId } : {}) });
        if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
        const state = response.job && typeof response.job === "object" && "state" in response.job
          ? response.job.state
          : undefined;
        if (typeof state !== "string") return errorResult(new Error("The relay returned no job state. Check the job with shadow_job_status; it was not resubmitted."));
        if (["succeeded", "failed", "cancelled", "interrupted"].includes(state)) return jsonResult(response);
      } catch (error) {
        return errorResult(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return errorResult(new Error(`Timed out waiting for job. Query it with shadow_job_status using the same ${jobId ? "jobId" : "requestId"}; it was not resubmitted.`));
  });

  server.registerTool("shadow_list_jobs", {
    description: "List recent jobs submitted to the paired Shadow server.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  }, async ({ limit }) => relayToolCall({ version: 1, type: "job.list", messageId: randomUUID(), ...(limit ? { limit } : {}) }));

  server.registerTool("shadow_cancel_job", {
    description: "Request cancellation of a queued or running job. A running job is cancelled only after the server confirms it.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async ({ jobId }) => relayToolCall({ version: 1, type: "job.cancel", messageId: randomUUID(), jobId }));

  server.registerTool("shadow_retry_job", {
    description: "Manually queue a new run for a failed job. Never used automatically. Supply retryRequestId to safely check or repeat an uncertain manual request.",
    inputSchema: z.object({ jobId: z.string().uuid(), retryRequestId: z.string().uuid().optional() }),
  }, async ({ jobId, retryRequestId }) => {
    const stableRetryRequestId = retryRequestId ?? randomUUID();
    try {
      const response = await callRelay({
        version: 1,
        type: "job.retry",
        messageId: randomUUID(),
        jobId,
        retryRequestId: stableRetryRequestId,
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
