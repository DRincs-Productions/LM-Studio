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

const SDCLI = path.join(ROOT, "bin", "sd-cli.exe");
const MODELS = path.join(ROOT, "models");

const WORK = path.join(ROOT, "work", "current");
const FINAL = path.join(ROOT, "output", "final");

const NORMAL_MODEL = path.join(
  MODELS,
  "sdxl_lightning_4step.safetensors"
);

const ADULT_MODEL = path.join(
  MODELS,
  "lustifyNSFWCheckpoint_zenithV9.safetensors"
);

const CODEX = "codex";

// Maximum time allowed for one Codex review.
const CODEX_TIMEOUT_MS = 120000;

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
  const root = path.resolve(ROOT).toLowerCase();

  return (
    requested === root ||
    requested.startsWith(root + path.sep.toLowerCase())
  );
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

  "Check the installed Image Worker components.",

  {},

  async () => {
    await ensureDirectories();

    const result = {
      sd_cli: await exists(SDCLI),
      normal_model: await exists(NORMAL_MODEL),
      adult_model: await exists(ADULT_MODEL),

      sd_cli_path: SDCLI,
      normal_model_path: NORMAL_MODEL,
      adult_model_path: ADULT_MODEL,

      work_directory: WORK,
      final_directory: FINAL,

      codex_command: CODEX
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

  "Generate exactly one image. Use normal for non-explicit scenes and adult for explicit consensual adult sexual scenes.",

  {
    generator: z.enum([
      "normal",
      "adult"
    ]),

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
      .min(1)
  },

  async ({
    generator,
    prompt,
    negative_prompt,
    seed,
    filename
  }) => {
    await ensureDirectories();

    // ---------------------------------------------
    // Select model
    // ---------------------------------------------

    const model =
      generator === "adult"
        ? ADULT_MODEL
        : NORMAL_MODEL;

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

    // ---------------------------------------------
    // Output
    // ---------------------------------------------

    const outputName = safeName(
      filename.toLowerCase().endsWith(".png")
        ? filename
        : `${filename}.png`
    );

    const outputPath = path.join(
      WORK,
      outputName
    );

    // Remove old image with same filename.
    try {
      await fs.unlink(outputPath);
    } catch {
      // fine
    }

    // ---------------------------------------------
    // Arguments
    // ---------------------------------------------

    let args;

    if (generator === "normal") {
      args = [
        "-m", model,

        "-p", prompt,
        "-n", negative_prompt,

        "-W", "1920",
        "-H", "1080",

        "--steps", "4",

        "--sampling-method",
        "euler",

        "--cfg-scale",
        "1",

        "--seed",
        String(seed),

        "--backend",
        "cuda0",

        "-o",
        outputPath
      ];
    } else {
      args = [
        "-m", model,

        "-p", prompt,
        "-n", negative_prompt,

        "-W", "1024",
        "-H", "576",

        "--steps", "20",

        "--sampling-method",
        "euler",

        "--cfg-scale",
        "4",

        "--seed",
        String(seed),

        "--backend",
        "cuda0",

        "-o",
        outputPath
      ];
    }

    // ---------------------------------------------
    // Generate
    // ---------------------------------------------

    const result = await runProcess(
      SDCLI,
      args
    );

    const created =
      await exists(outputPath);

    if (
      result.exitCode !== 0 ||
      !created
    ) {
      return {
        content: [{
          type: "text",
          text:
`FAILED
EXIT_CODE: ${result.exitCode}
FILE_CREATED: ${created}
PATH: ${outputPath}

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
PATH: ${outputPath}
SEED: ${seed}
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
8. overall scene substantially matches the request.

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
// START
// =========================================================

const transport =
  new StdioServerTransport();

await server.connect(transport);
