import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice('--run-id='.length)
  || `designer_krea2_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(5).toString('hex')}`;
if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) throw Error(`Unsafe run id: ${runId}`);
const seed = crypto.randomInt(1, 2147483647);
const runDirectory = path.join(root, 'production-tests', 'components', runId);
await fs.mkdir(runDirectory, { recursive: false });
const manifestPath = path.join(runDirectory, 'manifest.json');
const prompt = 'Create a natural, cinematic portrait of a fictional adult couple at an evening costume gala in a restored Prague theater: opera singer Lena Ward, age 36, long auburn hair, and stage designer Aki Tanaka, age 34, short black hair, share a warm consensual kiss in the private backstage dressing room. Both are fully clothed in elegant evening attire, shown from the knees up in a clear three-quarter composition, with soft practical lamplight and a quiet romantic mood. They are the only people; no nudity, sexual activity, violence, text, watermark, or logos.';
const negativePrompt = 'minor, underage, childlike features, extra people, duplicate people, fused bodies, merged bodies, malformed anatomy, extra limbs, missing heads, unreadable faces, text, watermark, logo';
const candidates = [
  { id: 'krea2_turbo', generator: 'normal', style: 'standard', model: 'C:\\AI\\image-worker\\models\\krea2_turbo_fp8_scaled.safetensors', steps: 8, cfgScale: 1 },
  { id: 'redcraft_redmix_hybrid', generator: 'adult', style: 'standard', adult_model: 'redcraft', model: 'C:\\AI\\image-worker\\models\\redcraftREDMIXHybridA2A_30Krea2.safetensors', steps: 12, cfgScale: 1 },
  { id: 'krea2_anime_v20', generator: 'normal', style: 'anime', model: 'C:\\AI\\image-worker\\models\\krea2Anime_v20_fp8.safetensors', steps: 12, cfgScale: 1 }
];
const manifest = {
  runId, inputSeed: seed, createdAt: new Date().toISOString(), mode: 'component', role: 'designer_image_worker',
  status: 'preflight', premise: prompt, negativePrompt, resolution: { width: 1024, height: 1024 },
  testScope: 'Compare Krea2 Turbo, RedCraft RedMix Hybrid, and Krea2 Anime v2.0 with the exact same prompt and seed; no LoRAs; generation and Codex review only. No finalization or publication.',
  inferenceEngine: path.join(root, 'image-worker', 'bin', 'sd-cli.exe'), candidates,
  loras: [], mcpCalls: [], outputs: [], authorization: 'component generation and review only'
};
const save = async () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const textOf = result => (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
const projectLog = path.join(runDirectory, 'project-worker-mcp-calls.jsonl');
const imageLog = path.join(runDirectory, 'image-worker-mcp-calls.jsonl');

async function call(client, logPath, name, args, timeoutMs = 120000) {
  const request = { name, arguments: args };
  let response;
  try {
    response = await client.callTool(request, undefined, { timeout: timeoutMs });
    await fs.appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), request, response }) + '\n');
  } catch (error) {
    await fs.appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), request, error: error.stack || error.message }) + '\n');
    throw error;
  }
  manifest.mcpCalls.push({ server: logPath === projectLog ? 'Project Worker' : 'Image Worker', name, isError: Boolean(response.isError) });
  await save();
  if (response.isError) throw Error(`${name} MCP error: ${textOf(response)}`);
  return { result: response, text: textOf(response) };
}

const projectClient = new Client({ name: 'image-three-krea2-project-test', version: '1.0.0' });
const projectTransport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'project-worker', 'mcp', 'server.mjs')], stderr: 'pipe',
  env: { ...process.env, BIONIC_PROJECTS_DIR: runDirectory }
});
const imageClient = new Client({ name: 'image-three-krea2-image-test', version: '1.0.0' });
const imageTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'image-worker', 'mcp', 'server.mjs')], stderr: 'pipe' });

try {
  await save();
  await projectClient.connect(projectTransport);
  await imageClient.connect(imageTransport);

  const projectText = `## Test Mode\nRun ID: ${runId}. Isolated Designer component comparison. Generate and review only; no finalization or publication.\n\n## Fresh Canon and Scenario\n${prompt}\n\n## Test Matrix\nCompare three installed Krea2-family profiles without LoRAs, using the same prompt, seed ${seed}, and 1024x1024 resolution.\n- Krea2 Turbo: standard profile, 8 steps, CFG 1.\n- RedCraft RedMix Hybrid: adult profile, 12 steps, CFG 1.\n- Krea2 Anime v2.0: anime style, 12 steps, CFG 1.\n`;
  const created = await call(projectClient, projectLog, 'create_project_file', { project_name: `designer-krea2-${runId}`, initial_content: projectText });
  const projectFile = created.text.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!projectFile) throw Error(`Project Worker did not return a new Project File: ${created.text}`);
  manifest.projectFile = projectFile;
  const readback = await call(projectClient, projectLog, 'read_project_file', { filename: projectFile });
  if (!readback.text.includes(prompt) || !readback.text.includes(runId)) throw Error('Fresh Project File read-back is incomplete.');
  const fixture = await call(projectClient, projectLog, 'record_component_test', {
    run_id: runId, role: 'designer', model: 'Image Worker / three Krea2-family profiles, no LoRA',
    input: `${prompt}\n\nCompare all three profiles with the same seed ${seed} and 1024x1024 resolution.`,
    response: 'Generate each declared candidate with no LoRAs, review each with Codex, and stop on any failed generation or review. Keep all files in staging.',
    interaction: 'handoff', mock_reply: 'Controlled test fixture recorded. No production or downstream role is authorized.'
  });
  manifest.projectWorkerRecording = fixture.text;

  const statusCall = await call(imageClient, imageLog, 'system_status', {});
  manifest.imageWorkerStatus = JSON.parse(statusCall.text);
  const status = manifest.imageWorkerStatus;
  const allProfilesAvailable = candidates.every(candidate => status.profiles?.[candidate.id]?.available);
  if (!status.sd_cli || !allProfilesAvailable || !status.encoder?.available || !status.vae?.available) {
    throw Error('Image Worker preflight found a missing profile, runtime, encoder, or VAE.');
  }
  manifest.status = 'generation_started';
  await save();

  for (const candidate of candidates) {
    const filename = `${runId}_${candidate.id}.png`;
    const generated = await call(imageClient, imageLog, 'generate_image', {
      generator: candidate.generator, style: candidate.style, adult_model: candidate.adult_model,
      prompt, negative_prompt: negativePrompt, seed, filename, width: 1024, height: 1024,
      steps: candidate.steps, cfg_scale: candidate.cfgScale, loras: []
    }, 60 * 60 * 1000);
    if (!/^SUCCESS\s*$/m.test(generated.text)) {
      manifest.outputs.push({ candidate: candidate.id, status: 'generation_failed', response: generated.text });
      manifest.status = 'stopped_after_generation_failure';
      manifest.stopReason = generated.text;
      await save();
      break;
    }
    const workerPath = generated.text.match(/^PATH:\s*(.*)$/m)?.[1]?.trim();
    if (!workerPath) throw Error(`Image Worker omitted PATH for ${candidate.id}.`);
    const runCopy = path.join(runDirectory, `${candidate.id}.png`);
    await fs.copyFile(workerPath, runCopy);
    const image = await fs.readFile(runCopy);
    if (!image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw Error(`Generated output is not PNG: ${workerPath}`);
    const output = {
      candidate: candidate.id, profile: candidate.id, model: candidate.model, workerPath, runCopy, seed,
      steps: candidate.steps, cfgScale: candidate.cfgScale, loras: [],
      sha256: crypto.createHash('sha256').update(image).digest('hex'), bytes: image.length,
      dimensions: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
      generationResponse: generated.text, status: 'generated'
    };
    manifest.outputs.push(output);
    await save();

    const review = await call(imageClient, imageLog, 'review_with_codex', {
      image_path: workerPath,
      original_request: `${prompt}\n\nThis is a non-explicit model-comparison candidate. Expected profile style: ${candidate.style}. Judge the two clearly adult characters, requested clothing, kiss, readable composition, faces, and absence of other people or severe anatomy errors. This candidate remains in staging.`
    }, 15 * 60 * 1000);
    output.review = review.text;
    output.score = Number(review.text.match(/^SCORE:\s*(\d+)\s*$/m)?.[1] ?? NaN);
    output.majorError = review.text.match(/^MAJOR_ERROR:\s*(YES|NO)\s*$/m)?.[1] ?? null;
    output.status = /^REVIEW_SUCCESS\s*$/m.test(review.text) ? 'reviewed' : 'review_failed';
    await save();
    console.log(JSON.stringify({ candidate: output.candidate, status: output.status, score: output.score, majorError: output.majorError, runCopy }));
    if (output.status === 'review_failed') {
      manifest.status = 'stopped_after_review_failure';
      manifest.stopReason = review.text;
      await save();
      break;
    }
  }
  if (!manifest.status.startsWith('stopped_after_')) {
    manifest.status = manifest.outputs.length === candidates.length && manifest.outputs.every(output => output.status === 'reviewed') ? 'completed_reviewed' : 'completed_with_failures';
  }
  manifest.completedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ runId, status: manifest.status, runDirectory, outputs: manifest.outputs.map(({ candidate, status, score, majorError, runCopy }) => ({ candidate, status, score, majorError, runCopy })) }, null, 2));
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.stack || error.message;
  manifest.completedAt = new Date().toISOString();
  await save();
  throw error;
} finally {
  await projectClient.close().catch(() => {});
  await imageClient.close().catch(() => {});
}
