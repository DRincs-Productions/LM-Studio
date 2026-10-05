import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = "C:\\Users\\Shadow\\.lmstudio\\audio\\worker";
const MODEL_ROOT = "C:\\AI\\audio-worker\\models";
const ASSETS = "C:\\AI\\assets";
const MCP_ROOT = "C:\\Users\\Shadow\\.lmstudio\\audio\\mcp";
const AUDIOCPP_ROOT = "C:\\Users\\Shadow\\.lmstudio\\audio\\audio.cpp\\v0.9.0-vulkan";
const AUDIOCPP_CLI = path.join(AUDIOCPP_ROOT, "audiocpp_cli.exe");
const AUDIOCPP_MODELS = path.join(MODEL_ROOT, "audio.cpp");
const TFLITE = path.join(ROOT, "runtime", "stable-audio-3", "optimized", "tflite");
const PYTHON = path.join(TFLITE, ".venv", "Scripts", "python.exe");
const GENERATOR = path.join(TFLITE, "scripts", "sa3_tflite.py");
const PY_TOOLS = path.join(MCP_ROOT, "audio_tools.py");
const RCLONE = "rclone";
const REMOTE_BASE = "imagecloud:AudioWorker";
const DEFAULT_TIMEOUT = 60 * 60 * 1000;
const MAX_OUTPUT = 12000;

const server = new McpServer({ name: "audio-worker-mcp", version: "1.1.0" });

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const isInside = (file, root) => {
  const resolved = path.resolve(file).toLowerCase();
  const base = path.resolve(root).toLowerCase();
  return resolved === base || resolved.startsWith(base + path.sep.toLowerCase());
};
const safeId = (v, label) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v)) throw new Error(`${label} must contain only letters, digits, dot, underscore, or hyphen (max 80).`);
  return v;
};
const safeFilename = (v) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.wav$/i.test(v)) throw new Error("filename must be a safe .wav filename.");
  return v;
};
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function hashFile(p) {
  const h = crypto.createHash("sha256");
  for await (const part of (await import("node:fs")).createReadStream(p)) h.update(part);
  return h.digest("hex");
}
function run(executable, args, { cwd, timeoutMs = 60000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const append = (target, chunk) => (target + chunk.toString()).slice(-MAX_OUTPUT);
    child.stdout.on("data", b => { stdout = append(stdout, b); });
    child.stderr.on("data", b => { stderr = append(stderr, b); });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on("error", e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`${path.basename(executable)} exited ${code}. ${stderr.slice(-3500)}`));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
async function toolPython(payload, timeoutMs = 120000) {
  // Send JSON through stdin without creating a command string or a temporary input file.
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [PY_TOOLS], { cwd: ROOT, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let stdout = "", stderr = "", settled = false;
    child.stdout.on("data", b => { stdout = (stdout + b.toString()).slice(-MAX_OUTPUT); });
    child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-MAX_OUTPUT); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    child.on("close", code => {
      clearTimeout(timer); if (settled) return; settled = true;
      if (code !== 0) reject(new Error(stderr.slice(-3500) || `Audio helper exited ${code}.`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Audio helper returned invalid JSON: ${stdout.slice(-1500)}`)); } }
    });
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}
function categoryDirs(category) {
  if (category === "music") return { local: "Music", remote: "Music" };
  if (category === "sound_effect") return { local: "SoundEffects", remote: "SoundEffects" };
  throw new Error("category must be music or sound_effect.");
}
function modelProfile(model, category) {
  if (model === "stable_audio_medium") return { modelPath: path.join(AUDIOCPP_MODELS, "Stable-Audio-3-Medium", "stable-audio-3-medium-q8_0.gguf"), supports: ["music", "sound_effect"], quality: "Stable Audio 3 Medium Q8 through audio.cpp" };
  if (model === "stable_audio_small_sfx") {
    if (category !== "sound_effect") throw new Error("Stable Audio Small SFX is restricted to sound_effect cues.");
    return { modelPath: path.join(AUDIOCPP_MODELS, "Stable-Audio-3-Small-SFX", "stable-audio-3-small-sfx-q8_0.gguf"), supports: ["sound_effect"], quality: "Stable Audio 3 Small SFX Q8 through audio.cpp" };
  }
  throw new Error("Unknown audio model. Available backends: stable_audio_medium, stable_audio_small_sfx.");
}
async function checkAudioPath(p) {
  const resolved = await fs.realpath(path.resolve(p));
  if (!(isInside(resolved, ROOT) || isInside(resolved, ASSETS))) throw new Error("Audio paths must be inside the Audio Worker staging folder or C:\\AI\\assets.");
  if (!/\.(wav|flac|ogg)$/i.test(resolved)) throw new Error("Only WAV, FLAC, and OGG are accepted.");
  const st = await fs.stat(resolved);
  if (!st.isFile()) throw new Error("Audio path must be a file.");
  return resolved;
}

server.tool("system_status", "Show Audio Worker backends, installed model files, storage destinations, and host resources.", {}, async () => {
  const models = {
    stable_audio_medium_q8: await exists(path.join(AUDIOCPP_MODELS, "Stable-Audio-3-Medium", "stable-audio-3-medium-q8_0.gguf")),
    stable_audio_small_sfx_q8: await exists(path.join(AUDIOCPP_MODELS, "Stable-Audio-3-Small-SFX", "stable-audio-3-small-sfx-q8_0.gguf")),
    audio_cpp_cli: await exists(AUDIOCPP_CLI),
    ace_step_xl_weights_present_runtime_unavailable: await exists(path.join(MODEL_ROOT, "ACE-Step", "acestep-v15-xl-sft")),
  };
  let remote = { configured: false };
  try {
    const r = await run(RCLONE, ["listremotes"], { timeoutMs: 15000 });
    remote = { configured: r.stdout.split(/\r?\n/).includes("imagecloud:") };
  } catch (e) { remote = { configured: false, error: e.message }; }
  let gpu = "unknown";
  try { gpu = (await run("nvidia-smi", ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"], { timeoutMs: 10000 })).stdout; } catch {}
  let devices = "unavailable";
  if (models.audio_cpp_cli) {
    try { devices = (await run(AUDIOCPP_CLI, ["--list-devices"], { timeoutMs: 30000 })).stdout; } catch (e) { devices = e.message; }
  }
  return text({ worker: "audio-worker-mcp", backend: "audio.cpp v0.9.0 Vulkan", models, audio_cpp_cli: AUDIOCPP_CLI, audio_cpp_models: AUDIOCPP_MODELS, legacy_stable_audio_tflite: await exists(PYTHON), staging_root: ROOT, generation_models_root: MODEL_ROOT, local_assets_root: ASSETS, remote, onedrive_targets: { sound_effects: `${REMOTE_BASE}/SoundEffects/final`, music: `${REMOTE_BASE}/Music/final` }, gpu, devices });
});

server.tool("generate_audio", "Generate one WAV cue from an explicit creative and implementation brief. Always classify it as music or sound_effect and define loop behavior, trigger, and stop condition.", {
  project_id: z.string().min(1).max(80), scene_id: z.string().min(1).max(80), cue_id: z.string().min(1).max(80),
  category: z.enum(["music", "sound_effect"]), description: z.string().min(5).max(4000), prompt: z.string().min(5).max(4000),
  loop: z.boolean(), loop_reason: z.string().min(3).max(1000), trigger: z.string().min(2).max(1000), stop_condition: z.string().min(2).max(1000),
  duration_seconds: z.number().min(1).max(180), model: z.enum(["stable_audio_medium", "stable_audio_small_sfx"]),
  seed: z.number().int().min(0).max(2147483647).optional(), steps: z.number().int().min(4).max(50).default(8),
  reference_audio_path: z.string().optional(), init_noise_level: z.number().min(0).max(1).default(0.7),
}, async (a) => {
  const project = safeId(a.project_id, "project_id"), scene = safeId(a.scene_id, "scene_id"), cue = safeId(a.cue_id, "cue_id");
  const dirs = categoryDirs(a.category), profile = modelProfile(a.model, a.category);
  if (a.loop && a.duration_seconds < 20) throw new Error("For loop cues, Stable Audio requires at least 20 seconds for better coherence. This still does not guarantee a seamless loop.");
  if (a.category === "music" && a.model === "stable_audio_small_sfx") throw new Error("Small SFX cannot generate music; select stable_audio_medium.");
  const outputDir = path.join(ROOT, "work", "jobs", project, scene, cue);
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${cue}-${stamp}.wav`;
  const outputPath = path.join(outputDir, filename);
  let finalPrompt = a.prompt;
  if (a.loop) finalPrompt += " Seamless looping game audio, maintain a consistent texture and energy, avoid a distinct ending, abrupt fade, or new transient at the end; the audio will be repeated.";
  if (!(await exists(AUDIOCPP_CLI))) throw new Error(`audio.cpp CLI not found: ${AUDIOCPP_CLI}`);
  if (!(await exists(profile.modelPath))) throw new Error(`audio.cpp model is not installed: ${profile.modelPath}`);
  const args = ["--task", "gen", "--family", "stable_audio", "--model", profile.modelPath, "--backend", "vulkan", "--device", "0", "--text", finalPrompt, "--duration-seconds", String(a.duration_seconds), "--num-inference-steps", String(a.steps), "--session-option", "stable_audio.mem_saver=true", "--request-option", "chunked_decode=true", "--out", outputPath];
  if (a.seed !== undefined) args.push("--seed", String(a.seed));
  if (a.reference_audio_path) {
    const reference = await checkAudioPath(a.reference_audio_path);
    args.push("--audio", reference, "--request-option", `init_noise_level=${a.init_noise_level}`);
  }
  const child = spawn(AUDIOCPP_CLI, args, { cwd: AUDIOCPP_ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout = (stdout + b.toString()).slice(-MAX_OUTPUT); });
  child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-MAX_OUTPUT); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), DEFAULT_TIMEOUT);
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("close", code => { clearTimeout(timer); resolve(code); });
  });
  if (exitCode !== 0 || !(await exists(outputPath))) throw new Error(`Audio generation failed (exit ${exitCode}). ${stderr.slice(-3000)}`);
  const technical = await toolPython({ operation: "inspect", path: outputPath });
  const referenceHash = a.reference_audio_path ? await hashFile(await checkAudioPath(a.reference_audio_path)) : null;
  const manifest = {
    schema: "audio-worker-cue-v1", project_id: project, scene_id: scene, cue_id: cue,
    category: a.category, description: a.description, loop: a.loop, loop_reason: a.loop_reason,
    trigger: a.trigger, stop_condition: a.stop_condition, requested_duration_seconds: a.duration_seconds,
    model: a.model, backend: "audio.cpp v0.9.0 Vulkan", model_path: profile.modelPath,
    prompt: finalPrompt, seed: a.seed ?? null, steps: a.steps,
    reference_audio: a.reference_audio_path ? { path: await checkAudioPath(a.reference_audio_path), sha256: referenceHash, mode: "audio_to_audio" } : null,
    output: outputPath, technical_inspection: technical,
    loop_status: a.loop ? "requires_repeated_listening_and_loop-point_approval" : "not_applicable",
    generated_at: new Date().toISOString(), status: "candidate"
  };
  await fs.writeFile(`${outputPath}.json`, JSON.stringify(manifest, null, 2), "utf8");
  return text({ status: "candidate_generated", audio_path: outputPath, manifest_path: `${outputPath}.json`, model_profile: profile, technical_inspection: technical, generation_logs_tail: (stdout + "\n" + stderr).slice(-2500), note: "Listen and review the candidate. Technical boundary metrics cannot certify semantic quality or a seamless loop." });
});

server.tool("inspect_audio", "Inspect an audio file technically and calculate diagnostic boundary metrics. This does not replace listening or certify a seamless loop.", { audio_path: z.string() }, async ({ audio_path }) => text(await toolPython({ operation: "inspect", path: await checkAudioPath(audio_path) })));

server.tool("create_loop_preview", "Create a repeated audition WAV from specified loop points. Optional crossfade only affects the preview; the source stays unchanged.", {
  audio_path: z.string(), loop_start_seconds: z.number().min(0), loop_end_seconds: z.number().positive(), repeats: z.number().int().min(2).max(20).default(4), crossfade_seconds: z.number().min(0).max(5).default(0)
}, async (a) => {
  const src = await checkAudioPath(a.audio_path);
  const out = path.join(ROOT, "work", "loop-previews", `${path.basename(src, path.extname(src))}-loop-preview-${Date.now()}.wav`);
  const result = await toolPython({ operation: "loop_preview", path: src, start_seconds: a.loop_start_seconds, end_seconds: a.loop_end_seconds, repeats: a.repeats, crossfade_seconds: a.crossfade_seconds, output_path: out });
  return text(result);
});

server.tool("finalize_audio", "Copy a reviewed WAV candidate and its manifest into the project's separate local Music or SoundEffects asset directory. Refuses overwrite.", {
  audio_path: z.string(), project_id: z.string().min(1).max(80), category: z.enum(["music", "sound_effect"]), filename: z.string().min(5).max(125).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.wav$/i)
}, async (a) => {
  const project = safeId(a.project_id, "project_id"), source = await checkAudioPath(a.audio_path), dirs = categoryDirs(a.category);
  if (!isInside(source, path.join(ROOT, "work", "jobs"))) throw new Error("Only generated job candidates under the Audio Worker work/jobs directory can be finalized.");
  const targetDir = path.join(ASSETS, project, "Audio", dirs.local);
  await fs.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, safeFilename(a.filename));
  if (await exists(target)) throw new Error("Target already exists; choose a new filename. Existing asset was left untouched.");
  if (await exists(`${target}.json`)) throw new Error("Target manifest already exists; choose a new filename. Existing asset was left untouched.");
  const manifestSource = `${source}.json`;
  if (!(await exists(manifestSource))) throw new Error("Candidate manifest is missing.");
  const manifest = JSON.parse(await fs.readFile(manifestSource, "utf8"));
  if (manifest.project_id !== project || manifest.category !== a.category) throw new Error("Project or category does not match the candidate manifest.");
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const finalManifest = { ...manifest, output: target, finalized_at: new Date().toISOString(), status: "finalized" };
  await fs.writeFile(`${target}.json`, JSON.stringify(finalManifest, null, 2), { encoding: "utf8", flag: "wx" });
  return text({ status: "finalized", audio_path: target, manifest_path: `${target}.json`, sha256: await hashFile(target), category_directory: dirs.local });
});

server.tool("publish_audio", "Copy a finalized project audio asset to its category-specific OneDrive folder and verify remote file size. No remote files are deleted.", { audio_path: z.string(), project_id: z.string().min(1).max(80), category: z.enum(["music", "sound_effect"]) }, async (a) => {
  const project = safeId(a.project_id, "project_id"), src = await checkAudioPath(a.audio_path), dirs = categoryDirs(a.category);
  if (!isInside(src, path.join(ASSETS, project, "Audio", dirs.local))) throw new Error("Source must already be finalized in the matching local project/category asset directory.");
  const file = path.basename(src), remote = `${REMOTE_BASE}/${dirs.remote}/final/${project}/${file}`;
  const manifestPath = `${src}.json`;
  if (!(await exists(manifestPath))) throw new Error("Finalized audio manifest is missing.");
  await run(RCLONE, ["copyto", src, remote, "--no-traverse"], { timeoutMs: 10 * 60 * 1000 });
  await run(RCLONE, ["copyto", manifestPath, `${remote}.json`, "--no-traverse"], { timeoutMs: 10 * 60 * 1000 });
  const result = await run(RCLONE, ["lsjson", "--stat", remote], { timeoutMs: 60000 });
  const stat = JSON.parse(result.stdout);
  const manifestResult = await run(RCLONE, ["lsjson", "--stat", `${remote}.json`], { timeoutMs: 60000 });
  const manifestStat = JSON.parse(manifestResult.stdout);
  const local = await fs.stat(src);
  const localManifest = await fs.stat(manifestPath);
  if (Number(stat.Size) !== local.size) throw new Error(`Remote size mismatch after upload. Local=${local.size}; remote=${stat.Size}; target=${remote}`);
  if (Number(manifestStat.Size) !== localManifest.size) throw new Error(`Remote manifest size mismatch after upload. Local=${localManifest.size}; remote=${manifestStat.Size}; target=${remote}.json`);
  return text({ status: "published", local_path: src, remote_path: remote, manifest_remote_path: `${remote}.json`, bytes_verified: { audio: local.size, manifest: localManifest.size }, sha256_local: { audio: await hashFile(src), manifest: await hashFile(manifestPath) }, note: "Remote sizes verified; remote hashing depends on OneDrive backend support." });
});

await server.connect(new StdioServerTransport());
