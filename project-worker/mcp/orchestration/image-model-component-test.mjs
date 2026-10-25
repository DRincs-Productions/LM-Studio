import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const projectWorker = path.join(root, 'project-worker', 'mcp', 'server.mjs');
const imageWorker = path.join(root, 'image-worker', 'mcp', 'server.mjs');
const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice('--run-id='.length)
  || `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}_${crypto.randomBytes(8).toString('hex')}`;
if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) throw Error(`Unsafe run id: ${runId}`);
const testSdCli = process.argv.find(arg => arg.startsWith('--sd-cli='))?.slice('--sd-cli='.length);
if (testSdCli) process.env.IMAGE_WORKER_SDCLI = path.resolve(testSdCli);
const seed = crypto.randomInt(1, 2147483647);
const artifactRoot = process.env.IMAGE_COMPONENT_TEST_ROOT
  ? path.resolve(process.env.IMAGE_COMPONENT_TEST_ROOT)
  : path.join(root, 'production-tests', 'components');
const runDirectory = path.join(artifactRoot, runId);
const projectName = `image-model-component-${runId}`;
const onlyCandidate = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length);
const standardPremise = `Fresh image-test premise ${seed}: At an evening costume gala in a restored Prague theater, fictional opera singer Lena Ward (36, long auburn hair) and stage carpenter Aki Tanaka (34, short black hair) pose together in the backstage dressing room. Show two clearly adult, fully clothed people, recognizable faces and hair, distinct bodies, warm lamplight, natural photographic style; no other people, no text, no watermark.`;
const premise = onlyCandidate === 'krea2_base' ? standardPremise : `Fresh image-test premise ${seed}: At an adults-only costume gala in a restored Prague theater, fictional adult opera singer Lena Ward (36, long auburn hair) and fictional adult stage carpenter Aki Tanaka (34, short black hair) share a consensual intimate moment in a private backstage dressing room. Show both clearly adult characters nude and embracing, recognizable faces and hair, anatomically distinct bodies, warm lamplight and tasteful romantic framing; no other people, no violence, no text, no watermark.`;
const animePrompt = `${premise} Render as a polished mature Japanese anime illustration, with clean expressive linework and controlled cel shading.`;
const negativePrompt = 'minors, underage appearance, childlike features, extra people, duplicate bodies, fused anatomy, extra limbs, missing heads, unreadable faces, text, watermark, logo';
const allCandidates = [
  { id: 'krea2_base', generator: 'normal', style: 'standard', model: 'krea2_turbo_fp8_scaled.safetensors', steps: 8, cfg_scale: 1, prompt: standardPremise },
  { id: 'redcraft', generator: 'adult', style: 'standard', adult_model: 'redcraft', model: 'redcraftREDMIXHybridA2A_30Krea2.safetensors', steps: 12, cfg_scale: 1, prompt: premise },
  { id: 'krea2_snofs', generator: 'adult', style: 'standard', adult_model: 'krea2_snofs', model: 'krea2_turbo_fp8_scaled.safetensors + snofs_krea_v1_5.safetensors (LoKR)', steps: 8, cfg_scale: 1, prompt: premise },
  { id: 'krea2_anime', generator: 'adult', style: 'anime', model: 'krea2Anime_v20_fp8.safetensors', steps: 12, cfg_scale: 1, prompt: animePrompt }
];
const candidates = onlyCandidate
  ? allCandidates.filter(candidate => candidate.id === onlyCandidate)
  : allCandidates.filter(candidate => candidate.id !== 'krea2_base');
if (!candidates.length) throw Error(`Unknown candidate: ${onlyCandidate}`);

await fs.mkdir(runDirectory, { recursive: true });
let convertedSnofsLora;
if (onlyCandidate === 'krea2_snofs') {
  const source = path.join('C:\\AI\\image-worker', 'loras', 'snofs_krea_v1_5.safetensors');
  const destination = path.join(runDirectory, 'snofs_krea_v1_5_sdcpp.safetensors');
  const handle = await fs.open(source, 'r');
  const sizeBytes = Buffer.alloc(8);
  await handle.read(sizeBytes, 0, 8, 0);
  const oldHeaderBytes = Number(sizeBytes.readBigUInt64LE());
  const oldHeader = Buffer.alloc(oldHeaderBytes);
  await handle.read(oldHeader, 0, oldHeaderBytes, 8);
  await handle.close();
  const header = JSON.parse(oldHeader.toString('utf8'));
  const transformed = {};
  for (const [name, value] of Object.entries(header)) {
    let target = name;
    if (name !== '__metadata__' && !name.startsWith('lora.')) {
      const adapterKey = name.match(/^(.*)\.(alpha|lokr_w1|lokr_w2)$/);
      if (!adapterKey || !name.startsWith('diffusion_model.')) throw Error(`Unexpected SNOFS tensor name: ${name}`);
      target = `lora.model.${adapterKey[1]}.weight.${adapterKey[2]}`;
    }
    if (transformed[target]) throw Error(`Safetensors key collision during SNOFS header conversion: ${target}`);
    transformed[target] = value;
  }
  const jsonHeader = Buffer.from(JSON.stringify(transformed), 'utf8');
  const padding = (8 - (jsonHeader.length % 8)) % 8;
  const newHeader = Buffer.concat([jsonHeader, Buffer.alloc(padding, 0x20)]);
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(newHeader.length));
  await fs.writeFile(destination, Buffer.concat([prefix, newHeader]));
  await pipeline(createReadStream(source, { start: 8 + oldHeaderBytes }), createWriteStream(destination, { flags: 'a' }));
  convertedSnofsLora = destination;
}
const manifestPath = path.join(runDirectory, 'manifest.json');
const manifest = {
  runId, inputSeed: seed, createdAt: new Date().toISOString(), mode: 'component', role: 'designer_image_worker',
  status: 'preflight', premise, negativePrompt, resolution: { width: 1024, height: 1024 },
  testScope: onlyCandidate ? `Isolated candidate verification: ${onlyCandidate}. Staging and review only; no finalization or publication.` : 'Compare the two non-anime adult model candidates with identical prompt and seed; separately verify the anime adult route. Staging and review only; no finalization or publication.',
  hardware: { gpu: 'NVIDIA RTX A4500', vramMiBAtStart: 20470 }, candidates, mcpCalls: [], outputs: []
};
manifest.inferenceEngine = {
  path: process.env.IMAGE_WORKER_SDCLI || path.join(root, 'image-worker', 'bin', 'sd-cli.exe'),
  build: process.env.IMAGE_WORKER_SDCLI_LABEL || 'installed stable-diffusion.cpp build'
};
if (convertedSnofsLora) manifest.adapterConversion = {
  source: 'C:\\AI\\image-worker\\loras\\snofs_krea_v1_5.safetensors',
  converted: convertedSnofsLora,
  transformation: 'Map Diffusers keys diffusion_model.<module>.<adapter> to stable-diffusion.cpp keys lora.model.diffusion_model.<module>.weight.<adapter>; safetensors payload and tensor offsets copied byte-for-byte.',
  mode: `sd-cli --lora-apply-mode ${process.env.IMAGE_WORKER_SNOFS_APPLY_MODE || 'at_runtime'}`,
  expectedAppliedTensors: 768
};
const saveManifest = async () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const projectLog = path.join(runDirectory, 'project-worker-mcp-calls.jsonl');
const imageLog = path.join(runDirectory, 'image-worker-mcp-calls.jsonl');
const textOf = result => (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');

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
  await saveManifest();
  if (response.isError) throw Error(`${name} MCP error: ${textOf(response)}`);
  return { result: response, text: textOf(response) };
}

const projectClient = new Client({ name: 'image-model-component-project-test', version: '1.0.0' });
const projectTransport = new StdioClientTransport({ command: process.execPath, args: [projectWorker], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: runDirectory } });
const imageClient = new Client({ name: 'image-model-component-image-test', version: '1.0.0' });
const imageTransport = new StdioClientTransport({
  command: process.execPath, args: [imageWorker], stderr: 'pipe',
  env: { ...process.env, ...(convertedSnofsLora ? { IMAGE_WORKER_SNOFS_LORA: convertedSnofsLora } : {}) }
});

try {
  await saveManifest();
  await projectClient.connect(projectTransport);
  await imageClient.connect(imageTransport);

  const initialProject = `## Test Mode\nComponent image-model comparison. No production, finalization, publication, or implementation is authorized.\n\n## Canon\n${premise}\n\n## Image Test Brief\nCompare RedCraft and Krea2 plus SNOFS LoKR on the same adult image prompt and seed. Separately test Krea2 Anime with adult content. Keep all characters fictional, consenting, and adults.\n\n## Visual Style\n- Style: Standard for the adult model comparison.\n- Anime route: Krea2 Anime V2.0 for both standard and adult anime scenes.\n`;
  const created = await call(projectClient, projectLog, 'create_project_file', { project_name: projectName, initial_content: initialProject });
  const projectFile = created.text.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!projectFile) throw Error(`Project Worker did not return the fresh Project File name: ${created.text}`);
  manifest.projectFile = projectFile;
  manifest.status = 'project_file_created';
  await saveManifest();

  const readback = await call(projectClient, projectLog, 'read_project_file', { filename: projectFile });
  if (!readback.text.includes(premise) || !readback.text.includes('Style: Standard')) throw Error('Project File read-back did not preserve the complete test fixture and style selection');
  const recorded = await call(projectClient, projectLog, 'record_component_test', {
    run_id: runId, role: 'designer', model: 'Image Worker model-profile comparison (Krea2 family)',
    input: `${premise}\n\nCompare RedCraft and Krea2 plus SNOFS with the exact same seed ${seed}. Then run one separate adult anime-style candidate with Krea2 Anime.`,
    response: 'Coordinator test fixture submitted for real Image Worker generation and Codex visual review. No candidate will be finalized or published.',
    interaction: 'handoff',
    mock_reply: 'Controlled component-test response: use only the declared isolated model candidates and stop after review.'
  });
  manifest.projectWorkerRecording = recorded.text;

  const statusCall = await call(imageClient, imageLog, 'system_status', {});
  manifest.imageWorkerStatus = JSON.parse(statusCall.text);
  if (!manifest.imageWorkerStatus.sd_cli || !manifest.imageWorkerStatus.normal_model || !manifest.imageWorkerStatus.adult_model || !manifest.imageWorkerStatus.anime_model) {
    throw Error('One or more real Image Worker model profiles or shared encoder/VAE dependencies are unavailable.');
  }
  manifest.status = 'generation_started';
  await saveManifest();

  for (const candidate of candidates) {
    const filename = `${runId}_${candidate.id}_attempt_01.png`;
    const callResult = await call(imageClient, imageLog, 'generate_image', {
      generator: candidate.generator, style: candidate.style, adult_model: candidate.adult_model,
      prompt: candidate.prompt, negative_prompt: negativePrompt, seed,
      filename, width: 1024, height: 1024, steps: candidate.steps, cfg_scale: candidate.cfg_scale
    }, 60 * 60 * 1000);
    if (!/^SUCCESS\s*$/m.test(callResult.text)) {
      manifest.outputs.push({ candidate: candidate.id, status: 'generation_failed', response: callResult.text });
      await saveManifest();
      continue;
    }
    const workerPath = callResult.text.match(/^PATH:\s*(.*)$/m)?.[1]?.trim();
    if (!workerPath) throw Error(`Image Worker omitted PATH for ${candidate.id}`);
    const runCopy = path.join(runDirectory, `${candidate.id}.png`);
    await fs.copyFile(workerPath, runCopy);
    const image = await fs.readFile(runCopy);
    const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) throw Error(`Image Worker output is not a PNG: ${workerPath}`);
    const dimensions = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
    const output = {
      candidate: candidate.id, model: candidate.model, workerPath, runCopy, seed,
      sha256: crypto.createHash('sha256').update(image).digest('hex'), bytes: image.length,
      dimensions, generationResponse: callResult.text, status: 'generated'
    };
    manifest.outputs.push(output);
    await saveManifest();

    const requestForReview = `${candidate.prompt}\n\nExpected style: ${candidate.style}. Requested content class: consenting adults; erotic adult scene. This is a model comparison candidate. Judge only the visible match, adult appearance, pose readability, anatomy, faces, and absence of extra people.`;
    const review = await call(imageClient, imageLog, 'review_with_codex', { image_path: workerPath, original_request: requestForReview }, 15 * 60 * 1000);
    output.review = review.text;
    output.score = Number(review.text.match(/^SCORE:\s*(\d+)\s*$/m)?.[1] ?? NaN);
    output.majorError = review.text.match(/^MAJOR_ERROR:\s*(YES|NO)\s*$/m)?.[1] ?? null;
    output.status = /^REVIEW_SUCCESS\s*$/m.test(review.text) ? 'reviewed' : 'review_failed';
    await saveManifest();
    console.log(JSON.stringify({ candidate: candidate.id, status: output.status, score: output.score, majorError: output.majorError, path: runCopy }));
  }

  manifest.status = manifest.outputs.length === candidates.length && manifest.outputs.every(output => output.status === 'reviewed') ? 'completed_reviewed' : 'completed_with_failures';
  manifest.completedAt = new Date().toISOString();
  await saveManifest();
  console.log(JSON.stringify({ runId, status: manifest.status, outputDirectory: runDirectory, outputs: manifest.outputs.map(({ candidate, status, score, majorError, runCopy }) => ({ candidate, status, score, majorError, runCopy })) }, null, 2));
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.stack || error.message;
  manifest.completedAt = new Date().toISOString();
  await saveManifest();
  throw error;
} finally {
  await projectClient.close().catch(() => {});
  await imageClient.close().catch(() => {});
}
