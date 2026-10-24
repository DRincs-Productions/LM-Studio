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
const PERCEPTION_ROOT = "C:\\Users\\Shadow\\.lmstudio\\audio\\llama.cpp\\b11560-vulkan";
const PERCEPTION_CLI = path.join(PERCEPTION_ROOT, "llama-mtmd-cli.exe");
const PERCEPTION_MODEL = "C:\\Users\\Shadow\\.lmstudio\\models\\ggml-org\\Qwen2.5-Omni-7B-GGUF\\Qwen2.5-Omni-7B-Q4_K_M.gguf";
const PERCEPTION_PROJECTOR = "C:\\Users\\Shadow\\.lmstudio\\models\\ggml-org\\Qwen2.5-Omni-7B-GGUF\\mmproj-Qwen2.5-Omni-7B-f16.gguf";
const PERCEPTION_PROFILE = "C:\\Users\\Shadow\\.lmstudio\\apps\\bionic\\.internal\\user-concrete-model-default-config\\ggml-org\\Qwen2.5-Omni-7B-GGUF\\Qwen2.5-Omni-7B-Q4_K_M.gguf.json";
const TFLITE = path.join(ROOT, "runtime", "stable-audio-3", "optimized", "tflite");
const PYTHON = path.join(TFLITE, ".venv", "Scripts", "python.exe");
const GENERATOR = path.join(TFLITE, "scripts", "sa3_tflite.py");
const PY_TOOLS = path.join(MCP_ROOT, "audio_tools.py");
const RCLONE = "rclone";
const REMOTE_BASE = "imagecloud:AudioWorker";
const DEFAULT_TIMEOUT = 60 * 60 * 1000;
const MAX_OUTPUT = 12000;

const server = new McpServer({ name: "audio-worker-mcp", version: "1.2.0" });

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

async function checkPerceptionEvidence(file, expectedHash) {
  const evidencePath = await fs.realpath(path.resolve(file));
  if (!isInside(evidencePath, ROOT)) throw new Error("Perception evidence must remain inside the Audio Worker staging folder.");
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  if (evidence.reviewer !== "Qwen2.5 Omni 7B Q4_K_M" || evidence.report?.status !== "analyzed" || evidence.report?.audio_sha256 !== expectedHash || evidence.technical_inspection?.sha256 !== expectedHash) throw new Error("Perception evidence is missing, invalid, or does not match the reviewed audio hash.");
  return { evidencePath, evidence };
}

function parseJsonOutput(text) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (let start = clean.lastIndexOf("{"); start >= 0; start = clean.lastIndexOf("{", start - 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < clean.length; end++) {
      const ch = clean[end];
      if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(clean.slice(start, end + 1));
          if (parsed && typeof parsed.status === "string" && typeof parsed.audible_summary === "string") return parsed;
        } catch {}
        break;
      }
    }
  }
  throw new Error("The local audio model returned no schema-matching JSON object.");
}

function runAudioPerception(args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PERCEPTION_CLI, args, { cwd: PERCEPTION_ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    child.stdout.on("data", b => { stdout = (stdout + b.toString()).slice(-MAX_OUTPUT); });
    child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-MAX_OUTPUT); });
    child.once("error", () => finish(new Error("Could not start the local audio-perception model.")));
    child.once("close", code => code === 0 ? finish(null, { stdout, stderr }) : finish(new Error(`Local audio-perception model exited with code ${code}. ${stderr.slice(-2500)}`)));
    const timer = setTimeout(() => { child.kill(); finish(new Error("Local audio-perception review exceeded its time limit.")); }, timeoutMs);
  });
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
  return text({ worker: "audio-worker-mcp", backend: "audio.cpp v0.9.0 Vulkan", models, audio_cpp_cli: AUDIOCPP_CLI, audio_cpp_models: AUDIOCPP_MODELS, audio_perception: { cli: PERCEPTION_CLI, model: PERCEPTION_MODEL, projector: PERCEPTION_PROJECTOR, installed: await exists(PERCEPTION_CLI) && await exists(PERCEPTION_MODEL) && await exists(PERCEPTION_PROJECTOR) }, legacy_stable_audio_tflite: await exists(PYTHON), staging_root: ROOT, generation_models_root: MODEL_ROOT, local_assets_root: ASSETS, remote, rclone_targets: { sound_effects: `${REMOTE_BASE}/SoundEffects/final`, music: `${REMOTE_BASE}/Music/final` }, gpu, devices });
});

server.tool("find_project_audio_assets", "Search only this project's existing audio assets and manifests before generating a new cue. Returns candidates for Codex to compare with the requested sound.", {
  project_id: z.string().min(1).max(80), category: z.enum(["music", "sound_effect"]).optional()
}, async ({ project_id, category }) => {
  const project = safeId(project_id, "project_id"), base = path.join(ASSETS, project, "Audio");
  if (!(await exists(base))) return text({ project_id: project, search_root: base, candidates: [] });
  const candidates = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !/\.(wav|flac|ogg)$/i.test(entry.name)) continue;
      const normalized = file.toLowerCase();
      const inferred = normalized.includes(`${path.sep}music${path.sep}`) ? "music" : normalized.includes(`${path.sep}soundeffects${path.sep}`) ? "sound_effect" : null;
      if (category && inferred && category !== inferred) continue;
      const stat = await fs.stat(file), manifestPath = `${file}.json`;
      let manifest = null;
      if (await exists(manifestPath)) { try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { manifest = { error: "manifest_invalid" }; } }
      candidates.push({ path: file, category: manifest?.category || inferred, bytes: stat.size, sha256: await hashFile(file), manifest_path: await exists(manifestPath) ? manifestPath : null,
        description: manifest?.description || null, prompt: manifest?.prompt || null, loop: typeof manifest?.loop === "boolean" ? manifest.loop : null,
        status: manifest?.status || "unmanifested", codex_review_score: manifest?.codex_review?.score ?? null,
        codex_major_error: manifest?.codex_review?.major_error ?? null, codex_review_decision: manifest?.codex_review?.decision ?? null });
    }
  }
  await walk(base);
  return text({ project_id: project, search_root: base, category_filter: category || null, candidates });
});

server.tool("review_audio", "Have the installed local Qwen audio model listen to a candidate or repeated-loop preview and return evidence only. Codex remains the approving reviewer.", {
  audio_path: z.string(), category: z.enum(["music", "sound_effect"]), description: z.string().min(5).max(3000), prompt: z.string().min(5).max(3000),
  loop: z.boolean(), loop_preview: z.boolean().default(false), trigger: z.string().min(2).max(500), stop_condition: z.string().min(2).max(500)
}, async (a) => {
  const audio = await checkAudioPath(a.audio_path);
  if (!(await exists(PERCEPTION_CLI)) || !(await exists(PERCEPTION_MODEL)) || !(await exists(PERCEPTION_PROJECTOR))) throw new Error("Local Qwen audio-review runtime, model, or projector is missing.");
  const profile = JSON.parse(await fs.readFile(PERCEPTION_PROFILE, "utf8"));
  const fields = Object.fromEntries((profile.operation?.fields || []).map(field => [field.key, field.value]));
  const systemPrompt = fields["llm.prediction.systemPrompt"];
  if (typeof systemPrompt !== "string" || !systemPrompt.includes('"audible_summary"')) throw new Error("The Bionic model profile has no compatible audio-perception system prompt.");
  const info = await toolPython({ operation: "inspect", path: audio });
  const loopInstruction = a.loop_preview
    ? "This file is an audition containing repeated playback transitions. Assess the audible transitions and whether a discontinuity is apparent."
    : a.loop ? "This is a single pass of a requested loop. Do not claim seam quality; state that the seam cannot be assessed from one pass." : "This is a one-shot cue, not a loop.";
  const userPrompt = `Listen to the attached audio. The actual clip duration is ${info.duration_seconds} seconds.\nCue category: ${a.category}\nCue description: ${a.description}\nIntended sound prompt: ${a.prompt}\nLoop requested: ${a.loop}\n${loopInstruction}\nTrigger: ${a.trigger}\nStop condition: ${a.stop_condition}\nReturn only the JSON object required by the system instructions.`;
  const args = ["-m", PERCEPTION_MODEL, "--mmproj", PERCEPTION_PROJECTOR, "--audio", audio, "-sys", systemPrompt, "-p", userPrompt, "--ctx-size", "8192", "-n", "1200", "--temp", "0.1", "--log-colors", "off", "--no-perf"];
  const result = await runAudioPerception(args);
  const report = parseJsonOutput(result.stdout + "\n" + result.stderr);
  if (!report || !["analyzed", "audio_not_accessible"].includes(report.status) || typeof report.audible_summary !== "string" || !Array.isArray(report.alignment_evidence) || !Array.isArray(report.issues) || !report.loop_assessment || typeof report.loop_assessment.requested !== "boolean" || typeof report.loop_assessment.can_assess !== "boolean" || typeof report.confidence !== "number") throw new Error("Local audio model returned a report that does not match the expected schema.");
  if (report.loop_assessment.requested !== a.loop) throw new Error("Local audio model did not preserve the cue's explicit loop flag.");
  if (report.clip_duration_seconds !== "unknown" && (!Number.isFinite(Number(report.clip_duration_seconds)) || Math.abs(Number(report.clip_duration_seconds) - info.duration_seconds) > 0.25)) throw new Error("Local audio model reported a clip duration inconsistent with the actual file.");
  const finalReport = { ...report, audio_sha256: info.sha256 };
  const evidencePath = `${audio}.review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await fs.writeFile(evidencePath, JSON.stringify({ reviewer: "Qwen2.5 Omni 7B Q4_K_M", audio_path: audio, technical_inspection: info, report: finalReport }, null, 2), { flag: "wx" });
  return text({ status: "perception_report_ready", reviewer: "Qwen2.5 Omni 7B Q4_K_M", audio_path: audio, audio_sha256: info.sha256, evidence_path: evidencePath, technical_inspection: info, report: finalReport, codex_must_make_final_decision: true });
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
  const priorCandidates = (await fs.readdir(outputDir, { withFileTypes: true })).filter(entry => entry.isFile() && /\.wav$/i.test(entry.name)).length;
  if (priorCandidates >= 3) throw new Error("This project/scene/cue has reached its three-candidate generation limit. Return the cue for creative revision instead of generating again.");
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

server.tool("record_codex_audio_review", "Persist Codex's score and retry decision beside a generated candidate. Approval requires at least 80 points and no major error.", {
  audio_path: z.string(), project_id: z.string().min(1).max(80), category: z.enum(["music", "sound_effect"]), perception_evidence_path: z.string(), loop_evidence_path: z.string().optional(),
  score: z.number().int().min(0).max(100), major_error: z.boolean(), summary: z.string().min(20).max(4000), retry_prompt: z.string().max(3000).optional()
}, async (a) => {
  const project = safeId(a.project_id, "project_id"), candidate = await checkAudioPath(a.audio_path);
  if (!isInside(candidate, path.join(ROOT, "work", "jobs"))) throw new Error("Codex reviews can only be recorded for generated candidates in the Audio Worker job staging area.");
  const manifestPath = candidate + ".json";
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.project_id !== project || manifest.category !== a.category) throw new Error("Project or category does not match the candidate manifest.");
  const candidateHash = await hashFile(candidate);
  const perceived = await checkPerceptionEvidence(a.perception_evidence_path, candidateHash);
  if (path.resolve(perceived.evidence.audio_path).toLowerCase() !== path.resolve(candidate).toLowerCase()) throw new Error("The candidate perception evidence does not belong to this exact WAV.");
  let loop = null;
  if (manifest.loop) {
    if (!a.loop_evidence_path) throw new Error("Loop candidates require a Qwen report for a repeated-loop preview.");
    const loopEvidencePath = await fs.realpath(path.resolve(a.loop_evidence_path));
    if (!isInside(loopEvidencePath, ROOT)) throw new Error("Loop evidence must remain inside the Audio Worker staging folder.");
    const rawLoopEvidence = JSON.parse(await fs.readFile(loopEvidencePath, "utf8"));
    loop = await checkPerceptionEvidence(loopEvidencePath, rawLoopEvidence.report?.audio_sha256);
    const loopPath = path.resolve(loop.evidence.audio_path).toLowerCase();
    if (!loopPath.includes((path.sep + "loop-previews" + path.sep).toLowerCase()) || loop.evidence.report.loop_assessment?.requested !== true || loop.evidence.report.loop_assessment?.can_assess !== true) throw new Error("Loop review evidence must come from an interpretable repeated-loop preview.");
  } else if (a.loop_evidence_path) throw new Error("A one-shot cue must not include a loop-preview report.");
  const decision = a.score >= 80 && !a.major_error ? "approved_for_finalization" : "revision_required";
  const review = { reviewer: "Codex", score: a.score, major_error: a.major_error, summary: a.summary, retry_prompt: a.retry_prompt || null, decision, candidate_sha256: candidateHash,
    perception_evidence_path: perceived.evidencePath, loop_evidence_path: loop?.evidencePath || null, reviewed_at: new Date().toISOString() };
  manifest.codex_reviews = [...(Array.isArray(manifest.codex_reviews) ? manifest.codex_reviews : []), review];
  manifest.codex_review = review;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return text({ ...review, attempts_used: (await fs.readdir(path.dirname(candidate))).filter(name => /\.wav$/i.test(name)).length, maximum_attempts: 3 });
});

server.tool("create_loop_preview", "Create a repeated audition WAV from specified loop points. Optional crossfade only affects the preview; the source stays unchanged.", {
  audio_path: z.string(), loop_start_seconds: z.number().min(0), loop_end_seconds: z.number().positive(), repeats: z.number().int().min(2).max(20).default(4), crossfade_seconds: z.number().min(0).max(5).default(0)
}, async (a) => {
  const src = await checkAudioPath(a.audio_path);
  const out = path.join(ROOT, "work", "loop-previews", `${path.basename(src, path.extname(src))}-loop-preview-${Date.now()}.wav`);
  const result = await toolPython({ operation: "loop_preview", path: src, start_seconds: a.loop_start_seconds, end_seconds: a.loop_end_seconds, repeats: a.repeats, crossfade_seconds: a.crossfade_seconds, output_path: out });
  return text(result);
});

server.tool("finalize_audio", "Copy a reviewed WAV candidate and its manifest into the project's separate local Music or SoundEffects asset directory. Refuses overwrite.", {
  audio_path: z.string(), project_id: z.string().min(1).max(80), category: z.enum(["music", "sound_effect"]), filename: z.string().min(5).max(125).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.wav$/i),
  perception_evidence_path: z.string(), loop_evidence_path: z.string().optional(),
  perception_report: z.object({ status: z.enum(["analyzed", "audio_not_accessible"]), clip_duration_seconds: z.union([z.string().max(100), z.number()]), audible_summary: z.string().max(4000), perceived_category: z.enum(["music", "sound_effect", "speech", "mixed", "uncertain"]), brief_alignment: z.enum(["aligned", "partial", "mismatch", "uncertain"]), alignment_evidence: z.array(z.string().max(1000)).max(30), issues: z.array(z.object({ time_range: z.string().max(100), observation: z.string().max(1000), severity: z.enum(["minor", "major"]) })).max(30), loop_assessment: z.object({ requested: z.boolean(), can_assess: z.boolean(), observation: z.string().max(2000) }), uncertainties: z.array(z.string().max(1000)).max(30), confidence: z.number().int().min(0).max(100), audio_sha256: z.string().regex(/^[a-f0-9]{64}$/i) }),
  loop_review_report: z.object({ status: z.enum(["analyzed", "audio_not_accessible"]), clip_duration_seconds: z.union([z.string().max(100), z.number()]), audible_summary: z.string().max(4000), perceived_category: z.enum(["music", "sound_effect", "speech", "mixed", "uncertain"]), brief_alignment: z.enum(["aligned", "partial", "mismatch", "uncertain"]), alignment_evidence: z.array(z.string().max(1000)).max(30), issues: z.array(z.object({ time_range: z.string().max(100), observation: z.string().max(1000), severity: z.enum(["minor", "major"]) })).max(30), loop_assessment: z.object({ requested: z.boolean(), can_assess: z.boolean(), observation: z.string().max(2000) }), uncertainties: z.array(z.string().max(1000)).max(30), confidence: z.number().int().min(0).max(100), audio_sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).optional(),
  codex_review: z.object({ score: z.number().int().min(0).max(100), major_error: z.boolean(), summary: z.string().min(20).max(4000), retry_prompt: z.string().max(3000).optional() })
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
  if (a.codex_review.score < 80 || a.codex_review.major_error) throw new Error("Audio candidate cannot be finalized: Codex review requires at least 80 points and no major error.");
  if (manifest.codex_review?.decision !== "approved_for_finalization" || manifest.codex_review?.candidate_sha256 !== await hashFile(source) || manifest.codex_review?.score !== a.codex_review.score || manifest.codex_review?.major_error !== a.codex_review.major_error || manifest.codex_review?.summary !== a.codex_review.summary) throw new Error("No matching passing Codex review is recorded for this candidate.");
  if (a.perception_report.status !== "analyzed" || a.perception_report.confidence < 25) throw new Error("Audio candidate cannot be finalized without an interpretable local listening report.");
  const candidateHash = await hashFile(source);
  if (a.perception_report.audio_sha256 !== candidateHash) throw new Error("Local perception report does not match this exact candidate audio.");
  const perceptionEvidence = await checkPerceptionEvidence(a.perception_evidence_path, candidateHash);
  if (manifest.codex_review.perception_evidence_path !== perceptionEvidence.evidencePath) throw new Error("Finalizer perception evidence differs from the review recorded by Codex.");
  if (JSON.stringify(perceptionEvidence.evidence.report) !== JSON.stringify(a.perception_report)) throw new Error("Submitted perception report differs from the saved local listening evidence.");
  if (a.perception_report.loop_assessment.requested !== manifest.loop) throw new Error("Listening report loop flag does not match the candidate manifest.");
  let loopEvidence = null;
  if (manifest.loop && (!a.loop_review_report || !a.loop_evidence_path || a.loop_review_report.status !== "analyzed" || a.loop_review_report.confidence < 25 || a.loop_review_report.loop_assessment.requested !== true || a.loop_review_report.loop_assessment.can_assess !== true)) throw new Error("A loop candidate requires an interpretable Qwen report on a repeated-loop preview.");
  if (manifest.loop) {
    loopEvidence = await checkPerceptionEvidence(a.loop_evidence_path, a.loop_review_report.audio_sha256);
    if (JSON.stringify(loopEvidence.evidence.report) !== JSON.stringify(a.loop_review_report) || !loopEvidence.evidence.audio_path.toLowerCase().includes(`${path.sep}loop-previews${path.sep}`.toLowerCase())) throw new Error("Loop review evidence must be the saved listening report for an actual repeated-loop preview.");
  }
  if (!manifest.loop && a.loop_review_report) throw new Error("A loop preview report must not be attached to a one-shot cue.");
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const finalManifest = { ...manifest, output: target, audio_sha256: await hashFile(target), perception_review: { ...a.perception_report, evidence_path: perceptionEvidence.evidencePath }, loop_perception_review: a.loop_review_report ? { ...a.loop_review_report, evidence_path: loopEvidence.evidencePath } : null, codex_review: { ...a.codex_review, decision: "approved_for_finalization", reviewer: "Codex", approved_at: new Date().toISOString() }, finalized_at: new Date().toISOString(), status: "finalized" };
  await fs.writeFile(`${target}.json`, JSON.stringify(finalManifest, null, 2), { encoding: "utf8", flag: "wx" });
  return text({ status: "finalized", audio_path: target, manifest_path: `${target}.json`, sha256: await hashFile(target), category_directory: dirs.local });
});

server.tool("publish_audio", "Publish a finalized project audio asset to its category-specific rclone destination and verify remote file size. No remote files are deleted.", { audio_path: z.string(), project_id: z.string().min(1).max(80), category: z.enum(["music", "sound_effect"]) }, async (a) => {
  const project = safeId(a.project_id, "project_id"), src = await checkAudioPath(a.audio_path), dirs = categoryDirs(a.category);
  if (!isInside(src, path.join(ASSETS, project, "Audio", dirs.local))) throw new Error("Source must already be finalized in the matching local project/category asset directory.");
  const file = path.basename(src), remote = `${REMOTE_BASE}/${dirs.remote}/final/${project}/${file}`;
  const manifestPath = `${src}.json`;
  if (!(await exists(manifestPath))) throw new Error("Finalized audio manifest is missing.");
  const finalManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (finalManifest.status !== "finalized" || finalManifest.codex_review?.score < 80 || finalManifest.codex_review?.major_error !== false) throw new Error("Only a Codex-approved finalized audio asset can be published.");
  if (finalManifest.audio_sha256 !== await hashFile(src)) throw new Error("Finalized WAV hash does not match its review manifest.");
  finalManifest.status = "published";
  finalManifest.remote_path = remote;
  finalManifest.remote_manifest_path = `${remote}.json`;
  finalManifest.published_at = new Date().toISOString();
  await fs.writeFile(manifestPath, JSON.stringify(finalManifest, null, 2), "utf8");
  await run(RCLONE, ["copyto", src, remote, "--no-traverse", "--immutable"], { timeoutMs: 10 * 60 * 1000 });
  await run(RCLONE, ["copyto", manifestPath, `${remote}.json`, "--no-traverse", "--immutable"], { timeoutMs: 10 * 60 * 1000 });
  const stat = JSON.parse((await run(RCLONE, ["lsjson", "--stat", remote], { timeoutMs: 60000 })).stdout);
  const manifestStat = JSON.parse((await run(RCLONE, ["lsjson", "--stat", `${remote}.json`], { timeoutMs: 60000 })).stdout);
  const local = await fs.stat(src);
  const localManifest = await fs.stat(manifestPath);
  if (Number(stat.Size) !== local.size) throw new Error(`Remote size mismatch after upload. Local=${local.size}; remote=${stat.Size}; target=${remote}`);
  if (Number(manifestStat.Size) !== localManifest.size) throw new Error(`Remote manifest size mismatch after upload. Local=${localManifest.size}; remote=${manifestStat.Size}; target=${remote}.json`);
  return text({ status: "published", local_path: src, remote_path: remote, manifest_remote_path: `${remote}.json`, bytes_verified: { audio: local.size, manifest: localManifest.size }, sha256_local: { audio: await hashFile(src), manifest: await hashFile(manifestPath) }, note: "Remote WAV and manifest sizes were verified; remote hashing depends on rclone backend support." });
});

await server.connect(new StdioServerTransport());
