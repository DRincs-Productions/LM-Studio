import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { clientStatus, enrollClient, getClientIdToken, login, logout } from "./auth.js";
import { callRelay, callRelaySequence, relayStatus, type RelayMessage } from "./relay-client.js";

const narrativePayload = z.object({
  projectId: z.string().uuid(),
  projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  brief: z.string().trim().min(1).max(12000),
  metadata: z.record(z.string(), z.json()).optional(),
});
const codexPayload = z.object({ task: z.string().trim().min(1).max(12000) }).strict();

const imageText = z.string().trim().min(1).refine((text) =>
  Buffer.byteLength(text) <= 12000 && !text.includes("\0"));
const imagePrompt = imageText.refine((text) => !/<\s*lora\s*:/i.test(text),
  "Declare LoRAs separately from the prompt.");
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
    description: "Submit a generic task for server-side OpenCode GPT-6 Luna, or a narrative.generate v1 request to the server narration queue. Then use shadow_wait_job or shadow_job_status with the returned requestId. Never resubmits automatically.",
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

  const characterCall = (action: string, fields: Record<string, unknown>) =>
    relayToolCall({ version: 1, type: "lora.character_" + action, messageId: randomUUID(), ...fields });
  server.registerTool("lora_create_character_job", {
    description: "Create an editable Krea 2 character LoRA draft.",
    inputSchema: z.object({ name: z.string(), trigger: z.string(), requestId: z.string().uuid(),
      characterId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional() }),
  }, async fields => characterCall("create", fields));
  server.registerTool("lora_stage_character_batch", {
    description: "Stage a batch of local character references on OneDrive for an editable LoRA draft.",
    inputSchema: z.object({
      jobId: z.string().uuid(),
      requestId: z.string().uuid(),
      files: z.array(z.object({
        imageId: z.string().uuid(), filePath: z.string().min(1),
        description: z.string().optional(),
      })).min(1).max(20),
    }),
  }, async ({ jobId, requestId, files }) => {
    const staging = await mkdtemp(join(tmpdir(), "shadow-lora-"));
    try {
      if (new Set(files.map(file => file.imageId)).size !== files.length) {
        throw new Error("Image IDs must be distinct");
      }
      const manifest = [];
      for (const { imageId, filePath, description = "" } of files) {
        if (Buffer.byteLength(description) > 1000) throw new Error("Image notes exceed 1000 bytes");
        const source = await open(filePath, "r");
        let bytes: Buffer;
        try {
          const stat = await source.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) {
            throw new Error("Choose a regular image file between 1 byte and 20 MiB");
          }
          bytes = Buffer.alloc(stat.size);
          if ((await source.read(bytes)).bytesRead !== bytes.length) throw new Error("Image changed during staging");
        } finally {
          await source.close();
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const local = join(staging, imageId);
        await writeFile(local, bytes, { flag: "wx" });
        await promisify(execFile)(process.env.SHADOW_RCLONE_EXECUTABLE || "rclone", [
          "copyto", "--immutable", local, `imagecloud:LoRAWorker/inbox/${jobId}/${requestId}/${imageId}-${sha256}`,
        ], { timeout: 120_000, windowsHide: true });
        manifest.push({ imageId, sha256, size: bytes.length, description });
      }
      return await characterCall("batch", { jobId, requestId, files: manifest });
    } catch (error) {
      return errorResult(error);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
  server.registerTool("lora_add_character_image", {
    description: "Upload one local character image and its Italian description. Reuse requestId to retry.",
    inputSchema: z.object({ jobId: z.string().uuid(), requestId: z.string().uuid(), filePath: z.string(), description: z.string() }),
  }, async ({ filePath, ...fields }) => {
    try {
      const file = await open(filePath, "r");
      let image: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) {
          throw new Error("Choose an image file between 1 byte and 20 MiB");
        }
        image = Buffer.alloc(stat.size);
        if ((await file.read(image)).bytesRead !== image.length) throw new Error("Image changed during upload");
      } finally {
        await file.close();
      }
      const sha256 = createHash("sha256").update(image).digest("hex");
      function* chunks(): Iterable<RelayMessage> {
        for (let offset = 0; offset < image.length; offset += 24000) {
          yield { version: 1, type: "lora.character_chunk", messageId: randomUUID(),
            ...fields, sha256, size: image.length, offset, chunk: image.subarray(offset, offset + 24000).toString("hex") };
        }
      }
      const response = await callRelaySequence(chunks());
      return response.type === "error" ? errorResult(new Error(errorMessage(response.error))) : jsonResult(response);
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("lora_remove_character_image", {
    description: "Remove a reference from an editable LoRA draft.",
    inputSchema: z.object({ jobId: z.string().uuid(), imageId: z.string().uuid() }),
  }, async ({ jobId, imageId }) => characterCall("remove", { jobId, requestId: imageId }));
  server.registerTool("lora_submit_character_job", {
    description: "Approve and freeze a prepared dataset for low priority LoRA training.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async fields => characterCall("submit", fields));
  server.registerTool("lora_promote_character_version", {
    description: "Mark the next dataset revision's first verified adapter as a new major version.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async fields => characterCall("promote", fields));

  server.registerTool("lora_import", {
    description: "Import a OneTrainer JSON export from the paired server's lora-inbox without starting it.",
    inputSchema: z.object({ fileName: z.string().min(1).max(120), requestId: z.string().uuid() }),
  }, async ({ fileName, requestId }) => relayToolCall({
    version: 1, type: "lora.import", messageId: randomUUID(), fileName, requestId,
  }));
  server.registerTool("lora_list", {
    description: "List your LoRA training jobs on the paired server.",
    inputSchema: z.object({}),
  }, async () => relayToolCall({ version: 1, type: "lora.list", messageId: randomUUID() }));
  for (const [action, description] of Object.entries({
    status: "Read LoRA job state and diagnostics.",
    attach: "Make a LoRA job eligible for automatic idle training.",
    detach: "Remove a LoRA job from scheduling and preserve its checkpoints.",
    start: "Enable training for an attached LoRA job.",
    pause: "Pause a LoRA job until explicitly resumed.",
    resume: "Enable an attached LoRA job to resume from its latest checkpoint.",
  })) {
    server.registerTool(`lora_${action}`, {
      description,
      inputSchema: z.object({ jobId: z.string().uuid(), imageId: z.string().uuid().optional() }),
    }, async ({ jobId, imageId }) => relayToolCall({
      version: 1, type: `lora.${action}`, messageId: randomUUID(), jobId, imageId,
    }));
  }

  const narrationInput = z.object({
    projectId: z.string().uuid(),
    projectSha256: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: z.record(z.string(), z.json()).optional(),
    requestId: z.string().uuid().optional(),
  });
  const submitNarration = async (brief: string, values: z.infer<typeof narrationInput>, payloadVersion: 1 | 2 = 1) => {
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
        payloadVersion, payload: { operation: "narrative.generate", params: payload },
      });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      return jsonResult({ requestId: stableRequestId, response });
    } catch (error) {
      return errorResult(new Error(`${errorMessage(error)} Request ID: ${stableRequestId}. Query this ID before submitting again.`));
    }
  };

  server.registerTool("shadow_submit_narration", {
    description: "Queue an English scene request for the paired Shadow server. The server runs the Writer, deterministic revisions and OpenCode GPT-6 Luna final edit, then publishes the result to OneDrive. Use shadow_wait_job, then get_narration_result before analysing the returned scene.",
    inputSchema: narrationInput.extend({ brief: z.string().trim().min(1).max(12000) }),
  }, async ({ brief, ...values }) => submitNarration(brief, values));

  const narrationFileInput = narrationInput.extend({ filePath: z.string().trim().min(1).max(2048) });
  const submitNarrationFile = async ({ filePath, ...values }: z.infer<typeof narrationFileInput>, payloadVersion: 1 | 2 = 1) => {
    try {
      const bytes = await readFile(filePath);
      if (!bytes.length || bytes.length > 12000) return errorResult(new Error("Narration request files must contain 1–12,000 bytes."));
      const brief = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (!brief) return errorResult(new Error("The selected narration request file is empty."));
      return submitNarration(brief, values, payloadVersion);
    } catch (error) {
      return errorResult(new Error(`Could not submit the selected narration file: ${errorMessage(error)}`));
    }
  };

  server.registerTool("shadow_submit_narration_file", {
    description: "Read the explicitly selected local Markdown/text request inside this MCP tool and queue its contents for server narration without returning or analysing the file contents in chat. Use shadow_wait_job, then get_narration_result before analysing the returned scene.",
    inputSchema: narrationFileInput,
  }, async values => submitNarrationFile(values));

  server.registerTool("shadow_submit_uncensored_narration", {
    description: "Queue an explicitly requested uncensored narration brief or selected UTF-8 file for direct final review by Venice Uncensored through OpenCode. Use shadow_wait_job and get_narration_result.",
    inputSchema: narrationInput.extend({
      brief: z.string().trim().min(1).max(12000).optional(),
      filePath: narrationFileInput.shape.filePath.optional(),
    }).refine(({ brief, filePath }) => Boolean(brief) !== Boolean(filePath), "Provide a brief or a prompt file."),
  }, async ({ brief, filePath, ...values }) => filePath
    ? submitNarrationFile({ ...values, filePath }, 2)
    : submitNarration(brief!, values, 2));

  const imageInput = z.strictObject({
    brief: imageText.optional(),
    filePath: z.string().trim().min(1).max(2048).optional(),
    negativePrompt: imagePrompt.optional(),
    requestId: z.string().uuid().optional(),
  }).refine(({ brief, filePath }) => Boolean(brief) !== Boolean(filePath), "Provide a brief or a prompt file.");

  const imageTools = [
    ["shadow_submit_normal_image", "normal", "a standard image"],
    ["shadow_submit_hot_image", "nsfw", "a RedCraft image"],
    ["shadow_submit_anime_image", "anime", "an anime image"],
  ] as const;
  for (const [name, profile, label] of imageTools) {
    server.registerTool(name, {
      description: `Queue ${label} on the paired server from a brief or an explicitly selected UTF-8 prompt file. Use shadow_wait_job and get_image_result.`,
      inputSchema: imageInput,
    }, async ({ requestId = randomUUID(), filePath, brief, ...options }) => {
      if (filePath) {
        try {
          const bytes = await readFile(filePath);
          if (!bytes.length || bytes.length > 12000) return errorResult(new Error("Image prompt files must contain 1–12,000 bytes."));
          brief = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (!imageText.safeParse(brief).success) return errorResult(new Error("The selected image prompt file is invalid or empty."));
        } catch {
          return errorResult(new Error("Could not read the selected UTF-8 image prompt file."));
        }
      }
      try {
        const response = await callRelay({
          version: 1, type: "job.submit", messageId: randomUUID(), requestId,
          payloadVersion: 1, payload: { operation: "image.generate", params: { ...options, profile, brief } },
        });
        if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
        return jsonResult({ requestId, response });
      } catch (error) {
        return errorResult(new Error(`${errorMessage(error)} Request ID: ${requestId}. Query this ID before submitting again.`));
      }
    });
  }

  server.registerTool("get_image_result", {
    description: "Download a published PNG for an authenticated image job and verify its SHA-256 before returning its local path.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async ({ jobId }) => {
    try {
      const response = await callRelay({ version: 1, type: "asset.get", messageId: randomUUID(), assetId: `image:${jobId}` });
      if (response.type === "error") return errorResult(new Error(errorMessage(response.error)));
      const source = `imagecloud:ImageWorker/final/${jobId}/image.png`;
      const maxBytes = 32 * 1024 * 1024;
      const asset = z.object({
        jobId: z.literal(jobId), kind: z.literal("image"), remotePath: z.literal(source),
        sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().min(1).max(maxBytes),
      }).parse(response.asset);
      const { stdout } = await promisify(execFile)("rclone", ["cat", source], {
        encoding: "buffer", timeout: 120_000, maxBuffer: maxBytes, windowsHide: true,
      });
      const sha256 = createHash("sha256").update(stdout).digest("hex");
      if (stdout.length !== asset.sizeBytes || sha256 !== asset.sha256) {
        return errorResult(new Error("Image download failed integrity verification."));
      }
      const root = join(homedir(), ".shadow-controller", "images");
      await mkdir(root, { recursive: true });
      const localPath = join(await mkdtemp(join(root, `${jobId}-`)), "image.png");
      await writeFile(localPath, stdout, { flag: "wx" });
      return jsonResult({ jobId, localPath, sha256, bytes: stdout.length });
    } catch {
      return errorResult(new Error("No downloadable image could be verified for this job."));
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
