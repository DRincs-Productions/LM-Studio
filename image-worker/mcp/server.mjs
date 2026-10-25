import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// =========================================================
// CONFIG
// =========================================================

const ROOT = "C:\\AI\\image-worker";
const WORKER_HOME = "C:\\Users\\Shadow\\.lmstudio\\image-worker";

const SDCLI = path.join(WORKER_HOME, "bin", "sd-cli.exe");
const MODELS = path.join(ROOT, "models");
const SHARED_MODELS = "C:\\Users\\Shadow\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\models";
const LORAS = path.join(ROOT, "loras");
const LORA_CATALOG_PATH = path.join(WORKER_HOME, "mcp", "image-loras.json");

const WORK = path.join(WORKER_HOME, "work", "current");
const FINAL = path.join(ROOT, "output", "final");

const ENCODER = path.join(SHARED_MODELS, "text_encoders", "qwen3vl_4b_fp8_scaled.safetensors");
const VAE = path.join(SHARED_MODELS, "vae", "qwen_image_vae.safetensors");
const PROFILES = {
  krea2_turbo: { file: "krea2_turbo_fp8_scaled.safetensors", loadFlag: "--diffusion-model", generator: "normal", style: "standard", steps: 8, cfgScale: 1 },
  redcraft_redmix_hybrid: { file: "redcraftREDMIXHybridA2A_30Krea2.safetensors", loadFlag: "-m", generator: "adult", style: "standard", steps: 12, cfgScale: 1 },
  krea2_anime_v20: { file: "krea2Anime_v20_fp8.safetensors", loadFlag: "--diffusion-model", generator: "both", style: "anime", steps: 12, cfgScale: 1 }
};
const PROFILE_PATHS = Object.fromEntries(Object.entries(PROFILES).map(([id, profile]) => [id, path.join(MODELS, profile.file)]));
const LORA_CATALOG = JSON.parse(await fs.readFile(LORA_CATALOG_PATH, "utf8")).loras;

const CODEX = "codex";

const RCLONE = "rclone";
const RCLONE_REMOTE = "imagecloud:";
const RCLONE_FINAL_DIR = "ImageWorker/final";
const RCLONE_TIMEOUT_MS = 120000;

// Maximum time allowed for one Codex review.
const CODEX_TIMEOUT_MS = 120000;
const IMAGE_TIMEOUT_MS = 60 * 60 * 1000;

// =========================================================
// SERVER
// =========================================================

const server = new McpServer({
  name: "image-worker-mcp",
  version: "2.0.0"
});

// =========================================================
// HELPERS
// =========================================================

async function ensureDirectories() {
  await fs.mkdir(WORK, { recursive: true });
  await fs.mkdir(FINAL, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_");
}

function isInsideRoot(filePath) {
  const requested = path.resolve(filePath).toLowerCase();
  const allowedRoots = [ROOT, WORK].map((root) => path.resolve(root).toLowerCase());
  return allowedRoots.some((root) => requested === root || requested.startsWith(root + path.sep.toLowerCase()));
}

function runProcess(executable, args, options = {}) {
  const {
    stdin = null,
    timeoutMs = 0
  } = options;

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;

        try {
          child.kill();
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);

      resolve({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);

      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut
      });
    });

    if (stdin !== null) {
      child.stdin.write(stdin);
    }

    child.stdin.end();
  });
}

function parseNumber(text, field) {
  const regex = new RegExp(
    `^${field}:\\s*(\\d{1,3})\\s*$`,
    "mi"
  );

  const match = text.match(regex);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);

  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    return null;
  }

  return value;
}

function parsePeople(text) {
  const match = text.match(
    /^PEOPLE:\s*(\d+)\s*$/mi
  );

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function parseMajorError(text) {
  const match = text.match(
    /^MAJOR_ERROR:\s*(YES|NO)\s*$/mi
  );

  if (!match) {
    return null;
  }

  return match[1].toUpperCase();
}

function parseRetryHint(text) {
  const match = text.match(
    /^RETRY_HINT:\s*(.+)$/mi
  );

  if (!match) {
    return null;
  }

  return match[1].trim();
}

// =========================================================
// TOOL 1 — system_status
// =========================================================

server.tool(
  "system_status",

  "Check the installed Image Worker components and cloud transport configuration.",

  {},

  async () => {
    await ensureDirectories();

    const result = {
      sd_cli: await exists(SDCLI),
      sd_cli_path: SDCLI,
      normal_model: await exists(PROFILE_PATHS.krea2_turbo),
      adult_model: await exists(PROFILE_PATHS.redcraft_redmix_hybrid),
      anime_model: await exists(PROFILE_PATHS.krea2_anime_v20),
      normal_model_path: PROFILE_PATHS.krea2_turbo,
      adult_model_path: PROFILE_PATHS.redcraft_redmix_hybrid,
      anime_model_path: PROFILE_PATHS.krea2_anime_v20,
      profiles: Object.fromEntries(await Promise.all(Object.entries(PROFILE_PATHS).map(async ([id, modelPath]) => [id, { path: modelPath, available: await exists(modelPath), ...PROFILES[id] }]))),
      encoder: { path: ENCODER, available: await exists(ENCODER) },
      vae: { path: VAE, available: await exists(VAE) },
      loras: Object.fromEntries(await Promise.all(Object.entries(LORA_CATALOG).map(async ([id, item]) => [id, { path: path.join(LORAS, item.file), available: await exists(path.join(LORAS, item.file)), minWeight: item.minWeight, maxWeight: item.maxWeight, profiles: item.profiles, validationStatus: item.validationStatus }]))),

      work_directory: WORK,
      final_directory: FINAL,

      codex_command: CODEX,

      rclone_command: RCLONE,
      rclone_remote: RCLONE_REMOTE,
      rclone_final_directory: RCLONE_FINAL_DIR
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }
);

// =========================================================
// TOOL 2 — generate_image
// =========================================================

server.tool(
  "generate_image",

  "Generate exactly one image. Anime style always selects Krea2 Anime. Adult non-anime selects RedCraft. Registered LoRAs are optional and are applied only when explicitly requested.",

  {
    generator: z.enum([
      "normal",
      "adult"
    ]),

    style: z.enum(["standard", "anime"]).optional().default("standard"),
    adult_model: z.enum(["redcraft", "krea2_snofs"]).optional(),
    steps: z.number().int().min(1).max(100).optional(),
    cfg_scale: z.number().min(0).max(30).optional(),
    loras: z.array(z.object({ id: z.string().min(1).max(100), weight: z.number().finite() })).max(4).optional().default([]),

    prompt: z.string().min(1),

    negative_prompt: z
      .string()
      .default(
        "extra people, duplicate people, fused bodies, merged bodies, missing head, headless person, malformed anatomy, extra limbs, broken face, unreadable face, text, watermark, logo"
      ),

    seed: z
      .number()
      .int()
      .nonnegative(),

    filename: z
      .string()
      .min(1),

    width: z.number().int().min(512).max(2048).optional(),
    height: z.number().int().min(512).max(2048).optional()
  },

  async ({
    generator,
    style,
    adult_model,
    steps,
    cfg_scale,
    loras,
    prompt,
    negative_prompt,
    seed,
    filename,
    width,
    height
  }) => {
    await ensureDirectories();

    // ---------------------------------------------
    // Select model
    // ---------------------------------------------

    if (adult_model === "krea2_snofs") {
      return { content: [{ type: "text", text: "FAILED\nREASON: SNOFS is a LoKR adapter and is not compatible with the verified sd-cli runtime." }] };
    }
    if (adult_model && generator !== "adult") {
      return { content: [{ type: "text", text: "FAILED\nREASON: adult_model can only be set when generator=adult." }] };
    }
    const profileId = style === "anime" ? "krea2_anime_v20" : generator === "adult" ? "redcraft_redmix_hybrid" : "krea2_turbo";
    if (generator === "adult" && adult_model && adult_model !== "redcraft") {
      return { content: [{ type: "text", text: `FAILED\nREASON: unsupported adult model: ${adult_model}` }] };
    }
    const profile = PROFILES[profileId];
    const model = PROFILE_PATHS[profileId];

    const selectedLoras = [];
    for (const requested of loras) {
      const registration = LORA_CATALOG[requested.id];
      if (!registration) return { content: [{ type: "text", text: `FAILED\nREASON: unregistered LoRA id: ${requested.id}` }] };
      if (registration.validationStatus !== "ready" && process.env.IMAGE_WORKER_ALLOW_UNVALIDATED_LORAS !== "1") {
        return { content: [{ type: "text", text: `FAILED\nREASON: ${requested.id} is not validated for this runtime (${registration.validationStatus}); it is disabled for production generation.` }] };
      }
      if (generator !== "adult" || style !== "standard" || profileId !== "redcraft_redmix_hybrid") {
        return { content: [{ type: "text", text: `FAILED\nREASON: ${requested.id} is registered only for adult, standard RedCraft generation.` }] };
      }
      if (!registration.profiles.includes(profileId) || registration.generator !== generator || registration.style !== style) {
        return { content: [{ type: "text", text: `FAILED\nREASON: ${requested.id} is not registered for the selected generation route.` }] };
      }
      if (requested.weight < registration.minWeight || requested.weight > registration.maxWeight || requested.weight === 0) {
        return { content: [{ type: "text", text: `FAILED\nREASON: ${requested.id} weight must be nonzero and within ${registration.minWeight}..${registration.maxWeight}.` }] };
      }
      selectedLoras.push({ ...requested, file: path.join(LORAS, registration.file) });
    }

    // ---------------------------------------------
    // Verify installation
    // ---------------------------------------------

    if (!(await exists(SDCLI))) {
      return {
        content: [{
          type: "text",
          text:
`FAILED
REASON: sd-cli.exe not found
PATH: ${SDCLI}`
        }]
      };
    }

    if (!(await exists(model))) {
      return {
        content: [{
          type: "text",
          text:
`FAILED
REASON: model not found
PATH: ${model}`
        }]
      };
    }
    for (const dependency of [ENCODER, VAE, ...selectedLoras.map(item => item.file)]) {
      if (!(await exists(dependency))) return { content: [{ type: "text", text: `FAILED\nREASON: required model dependency not found\nPATH: ${dependency}` }] };
    }

    // ---------------------------------------------
    // Output
    // ---------------------------------------------

    const outputName = safeName(
      filename.toLowerCase().endsWith(".png")
        ? filename
        : `${filename}.png`
    );

    const outputPath = path.join(WORK, outputName);
    if (!isInsideRoot(outputPath)) return { content: [{ type: "text", text: "FAILED\nREASON: output path is outside the worker staging directory" }] };
    if (await exists(outputPath)) return { content: [{ type: "text", text: `FAILED\nREASON: refusing to overwrite an existing image\nPATH: ${outputPath}` }] };

    // ---------------------------------------------
    // Arguments
    // ---------------------------------------------

    const args = [
      profile.loadFlag, model, "--llm", ENCODER, "--vae", VAE, "--lora-model-dir", LORAS,
      "-p", prompt + selectedLoras.map(item => ` <lora:${item.id}:${item.weight}>`).join(""),
      "-n", negative_prompt,
      "-W", String(width ?? 1024), "-H", String(height ?? 1024),
      "--steps", String(steps ?? profile.steps),
      "--sampling-method", "euler", "--scheduler", "simple",
      "--cfg-scale", String(cfg_scale ?? profile.cfgScale),
      "--seed", String(seed), "--backend", "cuda0", "-o", outputPath
    ];
    if (selectedLoras.length > 0) args.push("--lora-apply-mode", "at_runtime");

    // ---------------------------------------------
    // Generate
    // ---------------------------------------------

    const result = await runProcess(
      SDCLI,
      args,
      { timeoutMs: IMAGE_TIMEOUT_MS }
    );

    const created =
      await exists(outputPath);

    const loraApplication = `${result.stdout}\n${result.stderr}`.match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*LoRA tensors have been applied/i);
    const appliedLoraTensors = loraApplication ? Number(loraApplication[1]) : null;
    if (
      result.exitCode !== 0 || !created || (selectedLoras.length > 0 && !(appliedLoraTensors > 0))
    ) {
      return {
        content: [{
          type: "text",
          text:
`FAILED
EXIT_CODE: ${result.exitCode}
FILE_CREATED: ${created}
PATH: ${outputPath}
LORAS_REQUESTED: ${selectedLoras.map(item => `${item.id}@${item.weight}`).join(",") || "none"}
LORA_TENSORS_APPLIED: ${selectedLoras.length ? (loraApplication?.[0] ?? "unconfirmed or zero tensors") : "not requested"}

STDOUT:
${result.stdout}

STDERR:
${result.stderr}`
        }]
      };
    }

    const stats =
      await fs.stat(outputPath);

    return {
      content: [{
        type: "text",
        text:
`SUCCESS
GENERATOR: ${generator}
STYLE: ${style}
PROFILE: ${profileId}
MODEL_LOAD_FLAG: ${profile.loadFlag}
MODEL_PATH: ${model}
ENCODER_PATH: ${ENCODER}
VAE_PATH: ${VAE}
PATH: ${outputPath}
SEED: ${seed}
STEPS: ${steps ?? profile.steps}
CFG_SCALE: ${cfg_scale ?? profile.cfgScale}
LORAS: ${selectedLoras.map(item => `${item.id}@${item.weight}`).join(",") || "none"}
LORA_TENSORS_APPLIED: ${selectedLoras.length ? loraApplication[0] : "not requested"}
FILE_SIZE_BYTES: ${stats.size}`
      }]
    };
  }
);

// =========================================================
// TOOL 3 — file_exists
// =========================================================

server.tool(
  "file_exists",

  "Verify that a file physically exists inside the Image Worker directory.",

  {
    file_path:
      z.string().min(1)
  },

  async ({ file_path }) => {
    const resolved =
      path.resolve(file_path);

    if (!isInsideRoot(resolved)) {
      return {
        content: [{
          type: "text",
          text:
            "FALSE: path outside Image Worker root"
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text:
          (await exists(resolved))
            ? "TRUE"
            : "FALSE"
      }]
    };
  }
);

// =========================================================
// TOOL 4 — review_with_codex
// =========================================================

server.tool(
  "review_with_codex",

  "Have Codex visually inspect an actual generated image and return a numerical quality assessment. The original scene request must be supplied.",

  {
    image_path:
      z.string().min(1),

    original_request:
      z.string().min(1)
  },

  async ({
    image_path,
    original_request
  }) => {
    const resolved =
      path.resolve(image_path);

    // ---------------------------------------------
    // Validate path
    // ---------------------------------------------

    if (!isInsideRoot(resolved)) {
      return {
        content: [{
          type: "text",
          text:
`REVIEW_FAILED
REASON: image outside Image Worker root`
        }]
      };
    }

    if (!(await exists(resolved))) {
      return {
        content: [{
          type: "text",
          text:
`REVIEW_FAILED
REASON: image does not exist
PATH: ${resolved}`
        }]
      };
    }

    // ---------------------------------------------
    // Codex review prompt
    // ---------------------------------------------

    const reviewPrompt =
`You are a strict but practical image-quality reviewer.

Inspect ONLY the attached image.

Do not modify files.
Do not run shell commands.
Do not perform web searches.

ORIGINAL REQUEST:
${original_request}

Evaluate whether the generated image is usable for that request.

The objective is NOT perfection.
The objective is a clear, understandable and usable visual-novel image.

Prioritize:
1. correct number of principal characters;
2. requested principal characters are present;
3. major action roughly matches the request;
4. bodies are not fused or merged;
5. no missing heads;
6. no severe anatomical corruption;
7. faces are understandable when relevant;
8. overall scene substantially matches the request;
9. explicit canonical appearance requirements in ORIGINAL REQUEST (such as hair color and signature clothing) must be present. A contradictory or missing required canonical feature is a MAJOR_ERROR, not a minor clothing difference.

Do NOT heavily penalize:
- minor hand defects;
- small background mistakes;
- tiny object inaccuracies;
- minor clothing differences;
- insignificant decorative details.

SCORE must represent overall usability from 0 to 100.

90-100 = excellent
80-89 = good and usable
70-79 = usable but noticeably flawed
50-69 = poor
0-49 = failed

MAJOR_ERROR must be YES only for problems such as:
- fused or merged people;
- missing head;
- severe body corruption;
- wrong number of principal characters;
- important requested character absent;
- scene substantially unrelated to the request.

Return EXACTLY these six lines and nothing else:

SCORE: <0-100>
PEOPLE: <number>
REQUEST_MATCH: <0-100>
FACES: <0-100>
MAJOR_ERROR: <YES or NO>
RETRY_HINT: <one short actionable sentence, or NONE>`;

    // ---------------------------------------------
    // Execute Codex
    // ---------------------------------------------

    const result = await runProcess(
      CODEX,

      [
        "exec",

        "--skip-git-repo-check",

        "-i",
        resolved,

        "-"
      ],

      {
        stdin: reviewPrompt,
        timeoutMs: CODEX_TIMEOUT_MS
      }
    );

    // ---------------------------------------------
    // Execution failure
    // ---------------------------------------------

    if (result.timedOut) {
      return {
        content: [{
          type: "text",
          text:
`REVIEW_FAILED
REASON: Codex review timed out`
        }]
      };
    }

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text:
`REVIEW_FAILED
EXIT_CODE: ${result.exitCode}

STDOUT:
${result.stdout}

STDERR:
${result.stderr}`
        }]
      };
    }

    // ---------------------------------------------
    // Parse Codex final answer
    // ---------------------------------------------

    const text =
      result.stdout.trim();

    if (/\b(?:can't|can’t|cannot|unable to|declined to)\s+(?:evaluate|review|inspect|assess)\b/i.test(text)) {
      return {
        content: [{
          type: "text",
          text: `REVIEW_FAILED\nREASON: Codex declined to evaluate this image.\n\nRAW_RESPONSE:\n${text}`
        }]
      };
    }

    const score =
      parseNumber(text, "SCORE");

    const people =
      parsePeople(text);

    const requestMatch =
      parseNumber(
        text,
        "REQUEST_MATCH"
      );

    const faces =
      parseNumber(
        text,
        "FACES"
      );

    const majorError =
      parseMajorError(text);

    const retryHint =
      parseRetryHint(text);

    // ---------------------------------------------
    // Validate response
    // ---------------------------------------------

    if (
      score === null ||
      people === null ||
      requestMatch === null ||
      faces === null ||
      majorError === null ||
      retryHint === null
    ) {
      return {
        content: [{
          type: "text",
          text:
`REVIEW_FAILED
REASON: Could not parse Codex response

RAW_RESPONSE:
${text}`
        }]
      };
    }

    // ---------------------------------------------
    // Structured result
    // ---------------------------------------------

    return {
      content: [{
        type: "text",
        text:
`REVIEW_SUCCESS
SCORE: ${score}
PEOPLE: ${people}
REQUEST_MATCH: ${requestMatch}
FACES: ${faces}
MAJOR_ERROR: ${majorError}
RETRY_HINT: ${retryHint}`
      }]
    };
  }
);

// =========================================================
// TOOL 5 — finalize_image
// =========================================================

server.tool(
  "finalize_image",

  "Copy the selected generated image into the final Image Worker directory.",

  {
    source_path: z.string().min(1),
    final_filename: z.string().min(1)
  },

  async ({ source_path, final_filename }) => {
    await ensureDirectories();

    const source = path.resolve(source_path);

    if (!isInsideRoot(source)) {
      return {
        content: [{
          type: "text",
          text: "FAILED: source outside Image Worker root"
        }]
      };
    }

    if (!(await exists(source))) {
      return {
        content: [{
          type: "text",
          text:
`FAILED
REASON: source does not exist
PATH: ${source}`
        }]
      };
    }

    const filename = safeName(
      final_filename.toLowerCase().endsWith(".png")
        ? final_filename
        : `${final_filename}.png`
    );

    const destination = path.join(
      FINAL,
      filename
    );

    try {
      await fs.copyFile(
        source,
        destination
      );
    } catch (error) {
      return {
        content: [{
          type: "text",
          text:
`FAILED
REASON: final image could not be copied
ERROR: ${error.message}`
        }]
      };
    }

    if (!(await exists(destination))) {
      return {
        content: [{
          type: "text",
          text: "FAILED: final copy verification failed"
        }]
      };
    }

    const stats = await fs.stat(destination);

    return {
      content: [{
        type: "text",
        text:
`SUCCESS
FINAL_PATH: ${destination}
FILE_SIZE_BYTES: ${stats.size}`
      }]
    };
  }
);

// =========================================================
// TOOL 6 — publish_image
// =========================================================

server.tool(
  "publish_image",

  "Upload a finalized image to the configured cloud transport using rclone and verify that the remote file exists.",

  {
    local_path: z.string().min(1)
  },

  async ({ local_path }) => {
    await ensureDirectories();

    const source = path.resolve(local_path);
    const finalRoot = path.resolve(FINAL).toLowerCase();

    // ---------------------------------------------
    // Only finalized images may be published
    // ---------------------------------------------

    if (
      source.toLowerCase() !== finalRoot &&
      !source.toLowerCase().startsWith(
        finalRoot + path.sep.toLowerCase()
      )
    ) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: only files inside the final directory may be published
PATH: ${source}`
        }]
      };
    }

    // ---------------------------------------------
    // Verify local file
    // ---------------------------------------------

    if (!(await exists(source))) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: local file does not exist
PATH: ${source}`
        }]
      };
    }

    const filename = path.basename(source);

    const remoteRelativePath =
      `${RCLONE_FINAL_DIR}/${filename}`;

    const remoteTarget =
      `${RCLONE_REMOTE}${remoteRelativePath}`;

    // ---------------------------------------------
    // Upload
    // ---------------------------------------------

    const upload = await runProcess(
      RCLONE,
      [
        "copyto",
        source,
        remoteTarget
      ],
      {
        timeoutMs: RCLONE_TIMEOUT_MS
      }
    );

    if (upload.timedOut) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: rclone upload timed out
REMOTE_PATH: ${remoteRelativePath}`
        }]
      };
    }

    if (upload.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: rclone upload failed
EXIT_CODE: ${upload.exitCode}

STDOUT:
${upload.stdout}

STDERR:
${upload.stderr}`
        }]
      };
    }

    // ---------------------------------------------
    // Verify remote object
    // ---------------------------------------------

    const verify = await runProcess(
      RCLONE,
      [
        "lsjson",
        remoteTarget
      ],
      {
        timeoutMs: RCLONE_TIMEOUT_MS
      }
    );

    if (
      verify.timedOut ||
      verify.exitCode !== 0
    ) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: upload completed but remote verification failed
REMOTE_PATH: ${remoteRelativePath}

STDOUT:
${verify.stdout}

STDERR:
${verify.stderr}`
        }]
      };
    }

    let remoteInfo;

    try {
      remoteInfo =
        JSON.parse(verify.stdout);
    } catch {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: invalid rclone verification response
REMOTE_PATH: ${remoteRelativePath}`
        }]
      };
    }

    // rclone lsjson may return either one object or an array.
    if (Array.isArray(remoteInfo)) {
      remoteInfo = remoteInfo[0];
    }

    if (!remoteInfo) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: remote file was not found after upload
REMOTE_PATH: ${remoteRelativePath}`
        }]
      };
    }

    const localStats =
      await fs.stat(source);

    const remoteSize =
      Number(remoteInfo.Size);

    // ---------------------------------------------
    // Verify size
    // ---------------------------------------------

    if (
      Number.isFinite(remoteSize) &&
      remoteSize !== localStats.size
    ) {
      return {
        content: [{
          type: "text",
          text:
`PUBLISH_FAILED
REASON: remote file size does not match local file
LOCAL_SIZE_BYTES: ${localStats.size}
REMOTE_SIZE_BYTES: ${remoteSize}
REMOTE_PATH: ${remoteRelativePath}`
        }]
      };
    }

    // ---------------------------------------------
    // Success
    // ---------------------------------------------

    return {
      content: [{
        type: "text",
        text:
`PUBLISH_SUCCESS
FILENAME: ${filename}
REMOTE_PATH: ${remoteRelativePath}
REMOTE: ${RCLONE_REMOTE}
FILE_SIZE_BYTES: ${localStats.size}`
      }]
    };
  }
);

// =========================================================
// START
// =========================================================

const transport =
  new StdioServerTransport();

await server.connect(transport);

