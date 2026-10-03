import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// =========================================================
// CONFIG
// =========================================================

const RCLONE = "rclone";

const RCLONE_REMOTE = "imagecloud:";

const ALLOWED_REMOTE_ROOT =
  "ImageWorker/final/";

const RCLONE_TIMEOUT_MS =
  120000;

// =========================================================
// SERVER
// =========================================================

const server = new McpServer({
  name: "asset-worker-mcp",
  version: "1.0.0"
});

// =========================================================
// HELPERS
// =========================================================

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRemotePath(remotePath) {
  return remotePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function remotePathAllowed(remotePath) {
  const normalized =
    normalizeRemotePath(remotePath);

  return normalized.startsWith(
    ALLOWED_REMOTE_ROOT
  );
}

function runProcess(
  executable,
  args,
  options = {}
) {
  const {
    timeoutMs = 0
  } = options;

  return new Promise((resolve) => {
    const child = spawn(
      executable,
      args,
      {
        windowsHide: true,
        shell: false
      }
    );

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

    child.stdout.on(
      "data",
      (data) => {
        stdout += data.toString();
      }
    );

    child.stderr.on(
      "data",
      (data) => {
        stderr += data.toString();
      }
    );

    child.on(
      "error",
      (error) => {
        if (timer) {
          clearTimeout(timer);
        }

        resolve({
          exitCode: -1,
          stdout,
          stderr:
            `${stderr}\n${error.message}`,
          timedOut
        });
      }
    );

    child.on(
      "close",
      (code) => {
        if (timer) {
          clearTimeout(timer);
        }

        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          timedOut
        });
      }
    );

    child.stdin.end();
  });
}

// =========================================================
// TOOL 1 — file_exists
// =========================================================

server.tool(
  "file_exists",

  "Check whether a local asset file exists.",

  {
    file_path:
      z.string().min(1)
  },

  async ({ file_path }) => {
    const resolved =
      path.resolve(file_path);

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
// TOOL 2 — fetch_image
// =========================================================

server.tool(
  "fetch_image",

  "Download a finalized image from the configured cloud transport to a requested local project path.",

  {
    remote_path:
      z.string().min(1),

    destination_path:
      z.string().min(1)
  },

  async ({
    remote_path,
    destination_path
  }) => {
    const normalizedRemote =
      normalizeRemotePath(remote_path);

    // ---------------------------------------------
    // Remote boundary
    // ---------------------------------------------

    if (
      !remotePathAllowed(
        normalizedRemote
      )
    ) {
      return {
        content: [{
          type: "text",
          text:
`FETCH_FAILED
REASON: remote path outside allowed ImageWorker directory
REMOTE_PATH: ${normalizedRemote}`
        }]
      };
    }

    // ---------------------------------------------
    // Local destination
    // ---------------------------------------------

    const destination =
      path.resolve(destination_path);

    const destinationDirectory =
      path.dirname(destination);

    try {
      await fs.mkdir(
        destinationDirectory,
        {
          recursive: true
        }
      );
    } catch (error) {
      return {
        content: [{
          type: "text",
          text:
`FETCH_FAILED
REASON: destination directory could not be created
ERROR: ${error.message}`
        }]
      };
    }

    const remoteSource =
      `${RCLONE_REMOTE}${normalizedRemote}`;

    // ---------------------------------------------
    // Download
    // ---------------------------------------------

    const download =
      await runProcess(
        RCLONE,

        [
          "copyto",
          remoteSource,
          destination
        ],

        {
          timeoutMs:
            RCLONE_TIMEOUT_MS
        }
      );

    if (download.timedOut) {
      return {
        content: [{
          type: "text",
          text:
`FETCH_FAILED
REASON: rclone download timed out
REMOTE_PATH: ${normalizedRemote}`
        }]
      };
    }

    if (download.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text:
`FETCH_FAILED
REASON: rclone download failed
EXIT_CODE: ${download.exitCode}

STDOUT:
${download.stdout}

STDERR:
${download.stderr}`
        }]
      };
    }

    // ---------------------------------------------
    // Verify local file
    // ---------------------------------------------

    if (!(await exists(destination))) {
      return {
        content: [{
          type: "text",
          text:
`FETCH_FAILED
REASON: rclone returned success but destination file does not exist
LOCAL_PATH: ${destination}`
        }]
      };
    }

    const stats =
      await fs.stat(destination);

    // ---------------------------------------------
    // Success
    // ---------------------------------------------

    return {
      content: [{
        type: "text",
        text:
`FETCH_SUCCESS
REMOTE_PATH: ${normalizedRemote}
LOCAL_PATH: ${destination}
FILE_SIZE_BYTES: ${stats.size}`
      }]
    };
  }
);

// =========================================================
// TOOL 3 — delete_remote_image
// =========================================================

server.tool(
  "delete_remote_image",

  "Delete a finalized image from cloud storage only after verifying that its local downloaded copy exists and is non-empty.",

  {
    remote_path:
      z.string().min(1),

    verified_local_path:
      z.string().min(1)
  },

  async ({
    remote_path,
    verified_local_path
  }) => {
    const normalizedRemote =
      normalizeRemotePath(remote_path);

    // ---------------------------------------------
    // Remote security boundary
    // ---------------------------------------------

    if (!remotePathAllowed(normalizedRemote)) {
      return {
        content: [{
          type: "text",
          text:
`DELETE_FAILED
REASON: remote path outside allowed ImageWorker directory
REMOTE_PATH: ${normalizedRemote}`
        }]
      };
    }

    // ---------------------------------------------
    // Verify local copy
    // ---------------------------------------------

    const localPath =
      path.resolve(verified_local_path);

    if (!(await exists(localPath))) {
      return {
        content: [{
          type: "text",
          text:
`DELETE_FAILED
REASON: verified local copy does not exist
LOCAL_PATH: ${localPath}`
        }]
      };
    }

    let localStats;

    try {
      localStats =
        await fs.stat(localPath);
    } catch (error) {
      return {
        content: [{
          type: "text",
          text:
`DELETE_FAILED
REASON: local copy could not be inspected
ERROR: ${error.message}`
        }]
      };
    }

    if (
      !localStats.isFile() ||
      localStats.size <= 0
    ) {
      return {
        content: [{
          type: "text",
          text:
`DELETE_FAILED
REASON: local copy is not a valid non-empty file
LOCAL_PATH: ${localPath}`
        }]
      };
    }

    // ---------------------------------------------
    // Delete remote file
    // ---------------------------------------------

    const remoteTarget =
      `${RCLONE_REMOTE}${normalizedRemote}`;

    const deletion =
      await runProcess(
        RCLONE,
        [
          "deletefile",
          remoteTarget
        ],
        {
          timeoutMs:
            RCLONE_TIMEOUT_MS
        }
      );

    if (deletion.timedOut) {
      return {
        content: [{
          type: "text",
          text:
`DELETE_FAILED
REASON: rclone delete timed out
REMOTE_PATH: ${normalizedRemote}`
        }]
      };
    }

    if (deletion.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text:
`DELETE_FAILED
REASON: rclone delete failed
EXIT_CODE: ${deletion.exitCode}

STDOUT:
${deletion.stdout}

STDERR:
${deletion.stderr}`
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
`DELETE_SUCCESS
REMOTE_PATH: ${normalizedRemote}
VERIFIED_LOCAL_PATH: ${localPath}
LOCAL_FILE_SIZE_BYTES: ${localStats.size}`
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