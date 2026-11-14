import { execFile } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const [requestPath, runDir, skillPath] = process.argv.slice(2);
const { jobId, requestId, payload } = JSON.parse(await readFile(requestPath, 'utf8'));
const { brief, prompt: legacyPrompt, negativePrompt: requestedNegativePrompt, profile = 'normal', mode = 'standard', width = 1920, height = 1080, loras: requestedLoras = [] } = payload;
const seed = randomInt(1, 2147483647);
const routes = {
  normal: { generator: 'normal', style: 'standard', id: 'krea2_turbo', stepRange: [8, 8], reviewer: 'openai/gpt-6-luna' },
  nsfw: { generator: 'adult', style: 'standard', id: 'redcraft_redmix_hybrid', stepRange: [8, 12], reviewer: 'venice/venice-uncensored-1-2' },
  anime: { generator: 'normal', style: 'anime', id: 'krea2_anime_v20', stepRange: [8, 20], reviewer: 'venice/venice-uncensored-1-2' },
};
const route = routes[profile];
const reviewer = profile === 'normal' ? route.reviewer : process.env.SHADOW_IMAGE_VENICE_MODEL || route.reviewer;
const planner = profile === 'normal' ? (process.env.SHADOW_OPENCODE_MODEL || 'openai/gpt-6-luna') : reviewer;
const manifest = { schemaVersion: 1, runId: jobId, requestId, status: 'running', profile, mode, width, height, seed, checkpoint: route.id, planner, reviewer, stages: [] };
const manifestPath = path.join(runDir, 'result-manifest.json');
const save = async () => {
  const temp = manifestPath + '.tmp';
  await writeFile(temp, JSON.stringify(manifest, null, 2));
  await rename(temp, manifestPath);
};
const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const rclone = process.env.SHADOW_RCLONE_EXECUTABLE || 'rclone';
const remoteDir = `imagecloud:ImageWorker/final/${jobId}`;
const maxImageBytes = 32 * 1024 * 1024;
const worker = path.resolve(process.env.SHADOW_IMAGE_WORKER_ENTRY || path.join(homedir(), '.lmstudio', 'image-worker', 'mcp', 'server.mjs'));
let client;
let stage = 'preflight';
const started = Date.now();

async function command(executable, args, timeout, maxBuffer = 1024 * 1024) {
  return run(executable, args, { cwd: runDir, timeout, maxBuffer, encoding: 'buffer', windowsHide: true });
}

async function prepareImage(checkpoint, catalog) {
  const skill = await readFile(skillPath || new URL('../../../../skills/image-preparation/SKILL.md', import.meta.url), 'utf8');
  const [minSteps, maxSteps] = route.stepRange;
  const limits = {
    checkpoint: route.id, width, height, minSteps, maxSteps,
    defaults: { steps: checkpoint.steps, cfgScale: checkpoint.cfgScale },
    sampler: 'euler', scheduler: 'simple', readyLoras: catalog,
  };
  const request = {
    brief: brief ?? legacyPrompt, mode, negativePromptPreference: requestedNegativePrompt,
    requestedLoras,
  };
  const input = `${skill}\n\nSupported settings:\n${JSON.stringify(limits)}\n\nImage request:\n${JSON.stringify(request)}`;
  await writeFile(path.join(runDir, 'image-planner-input.txt'), input, { flag: 'wx' });
  const plannerDir = path.join(runDir, 'planner');
  await mkdir(plannerDir);
  const deny = [{ action: '*', resource: '*', effect: 'deny' }];
  await writeFile(path.join(plannerDir, 'opencode.json'), JSON.stringify({
    model: planner, mcp: { servers: {} }, permissions: deny,
    agents: { 'image-planner': { description: 'Prepare image prompt JSON.', mode: 'primary', model: planner, permissions: deny } },
  }), { flag: 'wx' });
  const executable = process.env.OPENCODE_EXECUTABLE || (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe') : 'opencode');
  const plan = run(executable, ['--standalone', 'run', '--model', planner, '--agent', 'image-planner',
    '--format', 'json', 'Prepare the image generation JSON from the supplied skill and request.'],
  { cwd: plannerDir, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true });
  plan.child.stdin?.end(input);
  let stdout;
  try {
    ({ stdout } = await plan);
  } catch (error) {
    await writeFile(path.join(runDir, 'image-planner.stderr.txt'), String(error.stderr ?? error.message));
    throw new Error('OpenCode image preparation failed');
  }
  await writeFile(path.join(runDir, 'image-planner.jsonl'), stdout, { flag: 'wx' });
  const response = stdout.split(/\r?\n/).flatMap(line => {
    try {
      const event = JSON.parse(line);
      return event?.type === 'text' && typeof event.part?.text === 'string' ? [event.part.text] : [];
    } catch { return []; }
  }).join('').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  const draft = JSON.parse(response);
  const validPrompt = text => typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= 12000
    && !text.includes('\0') && !/<\s*lora\s*:/i.test(text);
  const negativePrompt = draft?.negativePrompt === '' || draft?.negativePrompt === null ? undefined : draft?.negativePrompt;
  if (!validPrompt(draft?.prompt) || (negativePrompt !== undefined && !validPrompt(negativePrompt))
      || !Number.isInteger(draft.steps) || draft.steps < minSteps || draft.steps > maxSteps
      || draft.cfgScale !== checkpoint.cfgScale || !Array.isArray(draft.loras) || draft.loras.length > 4) {
    throw new Error('Image planner returned unsupported prompts or sampling settings');
  }
  const loras = draft.loras.map(selection => {
    const adapter = catalog.find(item => item.id === selection?.id);
    const weight = selection?.weight;
    if (!adapter || !Number.isFinite(weight) || weight === 0 || weight < adapter.minWeight || weight > adapter.maxWeight) {
      throw new Error('Image planner returned an unavailable or incompatible LoRA');
    }
    return { id: adapter.id, weight };
  });
  if (new Set(loras.map(item => item.id)).size !== loras.length) throw new Error('Image planner returned duplicate LoRAs');
  return { prompt: draft.prompt.trim(), negativePrompt, steps: draft.steps, cfgScale: draft.cfgScale, loras };
}

async function call(name, args, timeout, logName = name) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const message = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  await writeFile(path.join(runDir, `${logName}.txt`), message, { flag: 'wx' });
  if (response.isError) throw new Error(`Image Worker rejected ${name}`);
  return message;
}

function field(message, name) {
  return message.match(new RegExp(`^${name}: ([^\\r\\n]+)`, 'm'))?.[1];
}

function verifyPng(bytes) {
  if (bytes.length < 33 || bytes.length > maxImageBytes
      || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
    throw new Error('The PNG format or dimensions do not match the request');
  }
}

async function publish(local, remote, expected, maxBuffer) {
  await command(rclone, ['copyto', '--immutable', local, remote], 300_000);
  const { stdout } = await command(rclone, ['cat', remote], 120_000, maxBuffer);
  if (hash(stdout) !== hash(expected)) throw new Error('Published file failed SHA-256 verification');
}

try {
  await save();
  const require = createRequire(worker);
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const env = { ...process.env, IMAGE_WORKER_STAGING: runDir, IMAGE_WORKER_REVIEW_MODEL: reviewer, IMAGE_WORKER_ALLOW_UNVALIDATED_LORAS: '0', IMAGE_WORKER_MANAGED_JOB: '1' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [worker], stderr: 'inherit', env });
  client = new Client({ name: 'shadow-image-job', version: '1.0.0' });
  await client.connect(transport);
  const status = JSON.parse(await call('system_status', {}, 30_000));
  const checkpoint = status.profiles?.[route.id];
  if (!status.sd_cli || !checkpoint?.available || !status.encoder?.available || !status.vae?.available) {
    throw new Error('The image runtime, checkpoint, encoder or VAE is missing');
  }
  manifest.runtime = status.sd_cli_path;
  manifest.modelPath = checkpoint.path;
  manifest.encoderPath = status.encoder.path;
  manifest.vaePath = status.vae.path;
  stage = 'preparation';
  const registered = status.loras ?? {};
  const catalog = Object.entries(registered).filter(([, item]) =>
    item.available && item.validationStatus === 'ready' && item.profiles.includes(route.id))
    .map(([id, { minWeight, maxWeight, effect, preferredWeight, trigger }]) =>
      ({ id, minWeight, maxWeight, effect, preferredWeight, trigger }));
  const { prompt, negativePrompt, steps, cfgScale, loras } = await prepareImage(checkpoint, catalog);
  Object.assign(manifest, { steps, cfgScale, loras, loraPaths: loras.map(({ id }) => registered[id].path) });
  manifest.stages.push({ stage, outcome: 'verified', model: planner });
  await save();

  stage = 'generation';
  const transparent = mode === 'transparent';
  const sourceName = 'source.png';
  const source = path.join(runDir, sourceName);
  const final = path.join(runDir, 'image.png');
  const effectivePrompt = transparent
    ? `${prompt}\nIsolate the entire subject with space around it, against a uniform solid color that contrasts with its edges. No ground shadows, background objects, texture or gradients.`
    : prompt;
  const generationSettings = {
    checkpoint: route.id, seed, width, height, steps, cfgScale,
    sampler: 'euler', scheduler: 'simple', loras,
  };
  const generated = await call('generate_image', {
    generator: route.generator, style: route.style,
    width, height, seed, filename: sourceName, loras,
    prompt: effectivePrompt, negative_prompt: negativePrompt, steps, cfg_scale: cfgScale,
  }, 3_660_000);
  if (!/^SUCCESS\r?$/m.test(generated)) throw new Error('Image Worker failed generation; see the preserved tool output');
  manifest.loraApplication = field(generated, 'LORA_TENSORS_APPLIED');
  const reportedNegativePrompt = field(generated, 'NEGATIVE_PROMPT');
  generationSettings.negativePrompt = reportedNegativePrompt
    ? JSON.parse(reportedNegativePrompt) : negativePrompt;
  const sourceBytes = await readFile(source);
  verifyPng(sourceBytes);
  manifest.stages.push({ stage, outcome: 'verified', sha256: hash(sourceBytes), bytes: sourceBytes.length });
  await save();

  let preview = final;
  stage = 'postprocess';
  if (transparent) {
    preview = path.join(runDir, 'review-preview.png');
    const model = profile === 'anime' ? 'isnet-anime' : process.env.SHADOW_REMBG_STANDARD_MODEL || 'isnet-general-use';
    await command(process.env.SHADOW_IMAGE_PYTHON || 'python',
      [path.join(path.dirname(worker), 'transparent.py'), source, final, preview, model], 300_000);
    manifest.postprocess = { tool: 'rembg', model };
  } else {
    await writeFile(final, sourceBytes, { flag: 'wx' });
  }
  const initialPng = await readFile(final);
  verifyPng(initialPng);
  manifest.stages.push({ stage, outcome: 'verified' });
  await save();

  stage = 'review';
  const inspect = async (imagePath, logName, candidatePath) => {
    let evidence = '';
    let evidencePath;
    if (transparent) {
      const details = path.join(runDir, `${logName}-details.png`);
      const { stdout } = await command(process.env.SHADOW_IMAGE_PYTHON || 'python',
        [path.join(path.dirname(worker), 'transparent.py'), '--evidence', source, candidatePath, imagePath, details], 30_000);
      if (JSON.parse(stdout.toString()).length) evidencePath = details;
      evidence = `\nInspect these candidate boxes [left,top,right,bottom] in normalized 0..1000 coordinates: ${stdout.toString().trim()}. They contain opaque pixels resembling the original background color. Use the image to distinguish residue from the foreground.`;
    }
    const review = await call('review_with_opencode', {
      image_path: imagePath, original_request: `Original visual brief:\n${brief ?? legacyPrompt}\n\nPrepared prompt:\n${prompt}\n\nEffective generation prompt:\n${effectivePrompt}\n\nGeneration settings:\n${JSON.stringify({ ...generationSettings, loraApplication: manifest.loraApplication })}${evidence}`, inspect_alpha: transparent, evidence_path: evidencePath,
    }, 960_000, logName);
    const scoreText = field(review, 'SCORE');
    const score = /^\d{1,3}$/.test(scoreText ?? '') ? Number(scoreText) : null;
    const majorError = field(review, 'MAJOR_ERROR');
    if (!/^REVIEW_SUCCESS\r?$/m.test(review) || score === null || score > 100 || !['YES', 'NO'].includes(majorError)) {
      throw new Error('The visual reviewer did not return a verifiable verdict');
    }
    const residue = transparent ? JSON.parse(field(review, 'BACKGROUND_RESIDUE') ?? 'null') : [];
    if (!Array.isArray(residue) || residue.length > 4 || residue.some(polygon =>
      !Array.isArray(polygon) || polygon.length < 3 || polygon.length > 32
      || polygon.some(point => !Array.isArray(point) || point.length !== 2
        || point.some(n => !Number.isInteger(n) || n < 0 || n > 1000)))) {
      throw new Error('The reviewer could not verify or localize the background residue');
    }
    return { score, majorError: majorError === 'YES', residue };
  };
  let verdict = await inspect(preview, 'review_with_opencode', final);
  let delivery = final;
  if (verdict.residue.length) {
    stage = 'background_repair';
    const executable = process.env.SHADOW_PHOTOCRAFT_EXECUTABLE;
    if (!executable) throw new Error('PhotoCraft is not configured for background repair');
    const editor = new Client({ name: 'shadow-alpha-repair', version: '1.0.0' });
    try {
      await editor.connect(new StdioClientTransport({
        command: executable,
        args: ['mcp', '--automation-read-root', runDir, '--automation-write-root', runDir],
        env: { ...process.env, PHOTOCRAFT_CONTROL_PORT: '' },
        stderr: 'inherit',
      }));
      const edit = async (name, args) => {
        const result = await editor.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
        await writeFile(path.join(runDir, 'photocraft-repair.jsonl'), JSON.stringify({ name, args, result }) + '\n', { flag: 'a' });
        if (result.isError) throw new Error(`PhotoCraft failed ${name}`);
      };
      await edit('doc_open', { path: 'image.png' });
      for (const polygon of verdict.residue) {
        const points = polygon.map(([x, y]) => [Math.round(x * (width - 1) / 1000), Math.round(y * (height - 1) / 1000)]);
        await edit('command_run', { id: 'select.lasso', params: { points } });
        await edit('command_run', { id: 'edit.clear', params: {} });
      }
      await edit('doc_export', { path: 'image-repaired.png' });
    } finally {
      await editor.close();
    }
    delivery = path.join(runDir, 'image-repaired.png');
    preview = path.join(runDir, 'review-repaired.png');
    await command(process.env.SHADOW_IMAGE_PYTHON || 'python',
      [path.join(path.dirname(worker), 'transparent.py'), '--preview', delivery, preview], 300_000);
    manifest.stages.push({ stage, outcome: 'edited', editor: 'PhotoCraft', regions: verdict.residue });
    await save();
    stage = 'review';
    verdict = await inspect(preview, 'review_repaired', delivery);
  }
  manifest.review = verdict;
  const accepted = verdict.score >= 80 && !verdict.majorError && verdict.residue.length === 0;
  manifest.stages.push({ stage, outcome: accepted ? 'accepted' : 'rejected' });
  if (!accepted) throw new Error('The candidate did not pass visual review');
  const png = await readFile(delivery);
  verifyPng(png);
  await save();

  stage = 'publication';
  const imageRemotePath = remoteDir + '/image.png';
  const imageSha256 = hash(png);
  await publish(delivery, imageRemotePath, png, maxImageBytes);
  const completed = {
    ...manifest, status: 'succeeded', imageRemotePath, imageSha256, imageBytes: png.length,
    elapsedMs: Date.now() - started,
    stages: [...manifest.stages, { stage, outcome: 'verified' }],
  };
  const publishedManifest = path.join(runDir, 'published-manifest.json');
  const manifestBytes = Buffer.from(JSON.stringify(completed, null, 2));
  await writeFile(publishedManifest, manifestBytes, { flag: 'wx' });
  await publish(publishedManifest, remoteDir + '/manifest.json', manifestBytes, 1024 * 1024);
  Object.assign(manifest, completed);
  await save();
} catch (error) {
  console.error(error);
  manifest.status = 'failed';
  manifest.errorCode = `image_${stage}_failed`;
  manifest.error = `Image ${stage} failed. See the server run evidence.`;
  manifest.elapsedMs = Date.now() - started;
  delete manifest.imageRemotePath;
  delete manifest.imageSha256;
  delete manifest.imageBytes;
  await save();
  process.exitCode = 1;
} finally {
  await client?.close();
}
