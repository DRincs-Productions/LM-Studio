import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { store, installTools, registrationText, projectContext } from "./orchestration/tools.mjs";

// =========================================================
// CONFIG
// =========================================================

const PROJECTS_DIR = store.root;

// =========================================================
// SERVER
// =========================================================

const server = new McpServer({
  name: "project-worker-mcp",
  version: "1.0.0"
});

// =========================================================
// HELPERS
// =========================================================

async function ensureProjectsDirectory() {
  await fs.mkdir(PROJECTS_DIR, {
    recursive: true
  });
}

function sanitizeName(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

function resolveProjectFile(filename) {
  const safeFilename = path.basename(filename);

  if (
    safeFilename !== filename ||
    !safeFilename.toLowerCase().endsWith(".md")
  ) {
    throw new Error("Invalid project filename.");
  }

  const resolved = path.resolve(
    PROJECTS_DIR,
    safeFilename
  );

  const root = path.resolve(PROJECTS_DIR);

  if (
    resolved !== root &&
    !resolved.startsWith(root + path.sep)
  ) {
    throw new Error(
      "Project file outside allowed directory."
    );
  }

  return resolved;
}

// =========================================================
// TOOL 1 — create_project_file
// =========================================================

server.tool(
  "create_project_file",

  "Create a new uniquely named Markdown Project File. The returned filename must be used for the entire project pipeline.",

  {
    project_name: z.string().min(1),
    initial_content: z.string().default("")
  },

  async ({
    project_name,
    initial_content
  }) => {
    await ensureProjectsDirectory();

    const base =
      sanitizeName(project_name) || "project";

    const timestamp =
      new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..+$/, "")
        .replace("T", "_");

    const unique =
      crypto.randomBytes(3).toString("hex");

    const filename =
      `${base}_${timestamp}_${unique}.md`;

    const filePath =
      resolveProjectFile(filename);

    const header =
`# Bionic Project

Project File: ${filename}

`;

    await fs.writeFile(
      filePath,
      header + initial_content,
      {
        encoding: "utf8",
        flag: "wx"
      }
    );

    return {
      content: [{
        type: "text",
        text:
`PROJECT_FILE_CREATED
PROJECT_FILE: ${filename}
PATH: ${filePath}
${registrationText(await store.register(filename))}`
      }]
    };
  }
);

// =========================================================
// TOOL 2 — read_project_file
// =========================================================

server.tool(
  "read_project_file",

  "Read an existing Bionic Markdown Project File.",

  {
    filename: z.string().min(1)
  },

  async ({ filename }) => {
    try {
      const filePath =
        resolveProjectFile(filename);

      const content =
        await fs.readFile(
          filePath,
          "utf8"
        );

      return {
        content: [{
          type: "text",
          text:
`PROJECT_FILE_READ
PROJECT_FILE: ${filename}
PROJECT_CONTEXT: ${JSON.stringify(await projectContext(filename))}

${content}`
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
`PROJECT_FILE_READ_FAILED
PROJECT_FILE: ${filename}
ERROR: ${error.message}`
        }]
      };
    }
  }
);

// =========================================================
// TOOL 3 — update_project_file
// =========================================================

server.tool(
  "update_project_file",

  "Replace the complete contents of an existing Bionic Project File with a new consolidated English Markdown document.",

  {
    filename: z.string().min(1),
    content: z.string().min(1),
    expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  },

  async ({
    filename,
    content,
    expected_sha256
  }) => {
    try {
      const filePath =
        resolveProjectFile(filename);

      // Refuse accidental creation.
      await fs.access(filePath);

      await store.replaceProject(filename, content, expected_sha256);

      const stats =
        await fs.stat(filePath);

      return {
        content: [{
          type: "text",
          text:
`PROJECT_FILE_UPDATED
PROJECT_FILE: ${filename}
FILE_SIZE_BYTES: ${stats.size}`
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
`PROJECT_FILE_UPDATE_FAILED
PROJECT_FILE: ${filename}
ERROR: ${error.message}`
        }]
      };
    }
  }
);

// =========================================================
// START
// =========================================================

await ensureProjectsDirectory();

const transport =
  new StdioServerTransport();

installTools(server);
await server.connect(transport);