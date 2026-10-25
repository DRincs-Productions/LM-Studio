import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice('--run-id='.length)
  || `designer_lora_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(5).toString('hex')}`;
if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) throw Error(`Unsafe run id: ${runId}`);
const seed = crypto.randomInt(1, 2147483647);
const runDirectory = path.join(root, 'production-tests', 'components', runId);
await fs.mkdir(runDirectory, { recursive: false });
const manifestPath = path.join(runDirectory, 'manifest.json');
const prompt = 'Photorealistic neutral fine-art anatomical portrait of one fictional 34-year-old adult man standing alone in a private studio, full body, frontal three-quarter view, fully nude, clearly visible erect penis oriented 35 degrees upward and toward his left, natural adult anatomy and proportions, relaxed neutral expression, soft even studio lighting, plain warm-gray backdrop, no sexual activity, no other people, no text, no watermark.';
const negativePrompt = 'minor, underage, youthful appearance, sexual activity, extra people, duplicate body, fused anatomy, extra limbs, malformed anatomy, missing body parts, text, watermark, logo';
const candidates = [
  { id: 'redcraft_no_lora', loras: [], model: 'C:\\AI\\image-worker\\models\\redcraftREDMIXHybridA2A_30Krea2.safetensors', steps: 12, cfgScale: 1 },
  { id: 'redcraft_lora_plus3', loras: [{ id: 'flaccid_erect_krea2_loraholic', weight: 3 }], model: 'C:\\AI\\image-worker\\models\\redcraftREDMIXHybridA2A_30Krea2.safetensors', steps: 12, cfgScale: 1 },
  { id: 'redcraft_lora_minus3', loras: [{ id: 'flaccid_erect_krea2_loraholic', weight: -3 }], model: 'C:\\AI\\image-worker\\models\\redcraftREDMIXHybridA2A_30Krea2.safetensors', steps: 12, cfgScale: 1 }
];
const manifest = {
  runId, inputSeed: seed, createdAt: new Date().toISOString(), mode: 'component', role: 'designer_image_lora',
  status: 'preflight', scenario: 'Compare the registered erection-slider LoRA with RedCraft v3.0, without LoRA and at both signs of a moderate weight.',
  prompt, negativePrompt, resolution: { width: 1024, height: 1024 }, candidates,
  inferenceEngine: path.join(root, 'image-worker', 'bin', 'sd-cli.exe'),
  encoder: 'C:\\Users\\Shadow\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\models\\text_encoders\\qwen3vl_4b_fp8_scaled.safetensors',
  vae: 'C:\\Users\\Shadow\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\models\\vae\\qwen_image_vae.safetensors',
  adapterPath: 'C:\\AI\\image-worker\\loras\\flaccid_erect_krea2_loraholic.safetensors',
  mcpCalls: [], outputs: [], authorization: 'generation and review only; no finalization, publication, or implementation'
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

const projectClient = new Client({ name: 'image-lora-component-project-test', version: '1.0.0' });
const projectTransport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'project-worker', 'mcp', 'server.mjs')], stderr: 'pipe',
  env: { ...process.env, BIONIC_PROJECTS_DIR: runDirectory }
});
const imageClient = new Client({ name: 'image-lora-component-image-test', version: '1.0.0' });
const imageTransport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'image-worker', 'mcp', 'server.mjs')], stderr: 'pipe',
  env: { ...process.env, IMAGE_WORKER_ALLOW_UNVALIDATED_LORAS: '1' }
});

try {
  await save();
  await projectClient.connect(projectTransport);
  await imageClient.connect(imageTransport);

  const projectName = `designer-lora-${runId}`;
  const projectText = `## Test Mode\nRun ID: ${runId}. Isolated Designer component test. Generate and review only; no finalization or publication.\n\n## Fresh Canon and Scenario\n${prompt}\n\n## Image Profile\nRedCraft v3.0, adult non-anime, 1024x1024, 12 steps, CFG 1.\n\n## LoRA Comparison\nSame prompt and seed; baseline without adapters, then registered adapter at weights +3 and -3. The direction producing the requested erection/orientation is not assumed in advance.\n`;
  const created = await call(projectClient, projectLog, 'create_project_file', { project_name: projectName, initial_content: projectText });
  const projectFile = created.text.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!projectFile) throw Error(`Project Worker did not return a new Project File: ${created.text}`);
  manifest.projectFile = projectFile;
  const readback = await call(projectClient, projectLog, 'read_project_file', { filename: projectFile });
  if (!readback.text.includes(prompt) || !readback.text.includes(runId)) throw Error('Fresh Project File read-back is incomplete.');
  const fixture = await call(projectClient, projectLog, 'record_component_test', {
    run_id: runId, role: 'designer', model: 'Image Worker / RedCraft v3.0 with conditional LoRA comparison',
    input: `${prompt}\n\nUse the same seed ${seed} for a baseline and the registered LoRA at +3 and -3.`,
    response: 'Run isolated Image Worker generation and Codex review for each candidate. Keep all outputs in staging; do not finalize or publish.',
    interaction: 'handoff', mock_reply: 'Controlled test fixture recorded; proceed only with the declared candidates.'
  });
  manifest.projectWorkerRecording = fixture.text;

  const statusCall = await call(imageClient, imageLog, 'system_status', {});
  manifest.imageWorkerStatus = JSON.parse(statusCall.text);
  const status = manifest.imageWorkerStatus;
  if (!status.sd_cli || !status.adult_model || !status.encoder?.available || !status.vae?.available || !status.loras?.flaccid_erect_krea2_loraholic?.available) {
    throw Error('Image Worker preflight found a missing runtime, adult profile, encoder, VAE, or adapter.');
  }
  const invalidWeight = await call(imageClient, imageLog, 'generate_image', {
    generator: 'adult', style: 'standard', adult_model: 'redcraft', prompt, negative_prompt: negativePrompt,
    seed, filename: `${runId}_reject_out_of_range.png`, width: 1024, height: 1024,
    loras: [{ id: 'flaccid_erect_krea2_loraholic', weight: 7 }]
  });
  manifest.invalidWeightRejected = invalidWeight.text.startsWith('FAILED') && invalidWeight.text.includes('weight');
  if (!manifest.invalidWeightRejected) throw Error(`Out-of-range weight was not safely rejected: ${invalidWeight.text}`);

  manifest.status = 'generation_started';
  await save();
  for (const candidate of candidates) {
    const filename = `${runId}_${candidate.id}.png`;
    const generated = await call(imageClient, imageLog, 'generate_image', {
      generator: 'adult', style: 'standard', adult_model: 'redcraft', prompt,
      negative_prompt: negativePrompt, seed, filename, width: 1024, height: 1024,
      steps: 12, cfg_scale: 1, loras: candidate.loras
    }, 60 * 60 * 1000);
    if (!/^SUCCESS\s*$/m.test(generated.text)) {
      const failed = { candidate: candidate.id, status: 'generation_failed', response: generated.text };
      manifest.outputs.push(failed); await save();
      throw Error(`Generation stopped after failure; evidence retained: ${generated.text}`);
    }
    const workerPath = generated.text.match(/^PATH:\s*(.*)$/m)?.[1]?.trim();
    if (!workerPath) throw Error(`Image Worker omitted PATH for ${candidate.id}.`);
    const runCopy = path.join(runDirectory, `${candidate.id}.png`);
    await fs.copyFile(workerPath, runCopy);
    const image = await fs.readFile(runCopy);
    if (!image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw Error(`Generated output is not PNG: ${workerPath}`);
    const output = {
      candidate: candidate.id, profile: 'redcraft_redmix_hybrid', model: candidate.model,
      loras: candidate.loras, workerPath, runCopy, seed, steps: 12, cfgScale: 1,
      sha256: crypto.createHash('sha256').update(image).digest('hex'), bytes: image.length,
      dimensions: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }, generationResponse: generated.text,
      status: 'generated'
    };
    manifest.outputs.push(output); await save();
    const review = await call(imageClient, imageLog, 'review_with_codex', {
      image_path: workerPath,
      original_request: `${prompt}\n\nThis is an adult non-anime comparison candidate. Judge whether the subject appears clearly adult, is fully nude, has an erection angled upward and toward his left at about 35 degrees, and has readable natural anatomy. Note severe anatomical errors. This candidate remains in staging.`
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
      manifest.completedAt = new Date().toISOString();
      await save();
      break;
    }
  }
  if (manifest.status !== 'stopped_after_review_failure') {
    manifest.status = manifest.outputs.length === candidates.length && manifest.outputs.every(output => output.status === 'reviewed') ? 'completed_reviewed' : 'completed_with_failures';
    manifest.completedAt = new Date().toISOString();
  }
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
