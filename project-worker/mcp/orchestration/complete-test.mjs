import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, sha } from './core.mjs';

const lmRoot = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.lmstudio');
const lms = path.join(lmRoot, 'bin', 'lms.exe');
const worker = path.join(lmRoot, 'project-worker', 'mcp', 'server.mjs');
const projectRootArg = process.argv.find(x => x.startsWith('--root='))?.slice('--root='.length);
if (!projectRootArg) throw Error('Usage: node complete-test.mjs --root="C:\\Users\\Shadow\\.lmstudio\\production-tests\\complete\\<fresh-run>"');
const runRoot = path.resolve(projectRootArg);
const approvedRoot = path.join(lmRoot, 'production-tests', 'complete');
if (!runRoot.toLowerCase().startsWith(approvedRoot.toLowerCase() + path.sep)) throw Error('Complete test root must be a new directory under .lmstudio/production-tests/complete');
if (await fs.access(path.join(runRoot, 'manifest.json')).then(() => true).catch(() => false)) throw Error('This complete test already has a manifest; use a fresh root for every run');
const gameRoot = path.join(runRoot, 'game');
const projectWorkspace = path.join(runRoot, 'workspace');
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${crypto.randomBytes(5).toString('hex')}`;
const seed = crypto.randomBytes(4).toString('hex');
const testInput = `Independent full-pipeline test ${seed}: create a compact, playable romantic mystery visual novel called “After the Last Broadcast”. The story follows two adult leads, Tali Rook (29), a witty night-shift botanist who tends a rooftop greenhouse, and Ivo Senn (33), a thoughtful overnight radio engineer. At their small station above the greenhouse, a strange transmission seems to arrive from a few minutes in the future. They trace it through a late-night signal and discover that a message in Tali’s own voice is inviting Ivo to stay for the dawn opening of a rare flower. Keep the tone warm, playful, lightly flirtatious, and mysterious; resolve the central mystery with an emotionally satisfying, gently comic ending. The story should have enough distinct moments for useful visual scenes. Decide from the story which visual moments deserve images and which audio moments deserve cues; do not force fixed image or audio quantities. For each audio cue, decide whether it is music or a sound effect, whether it loops, its trigger and stop condition. Avoid branching choices unless needed by the approved design. The user approves this direction for a terminal-only end-to-end test and will separately approve implementation after choosing the Programmer.`;

const records = [];
const record = async (stage, data) => { records.push({ at: new Date().toISOString(), stage, ...data }); await saveManifest(); };
const manifest = { runId, seed, mode: 'complete', createdAt: new Date().toISOString(), testInput, gameRoot, projectWorkspace, stages: records, status: 'running' };
await fs.mkdir(runRoot, { recursive: true });
await fs.mkdir(projectWorkspace, { recursive: true });
async function saveManifest() { await fs.writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); }
function textOf(result) { return (result.content || []).map(item => item.text || '').join('\n'); }
function parseTool(result, name) {
  if (result.isError) throw Error(`${name} returned MCP error: ${textOf(result).slice(0, 1200)}`);
  let value = textOf(result);
  for (let depth = 0; depth < 3; depth++) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { return { text: value }; }
    if (parsed?.content?.length && typeof parsed.content[0].text === 'string') {
      value = parsed.content.map(item => item.text || '').join('\n');
      continue;
    }
    return parsed;
  }
  return { text: value };
}
function cleanCliText(value) {
  return value.replace(/^[\s\S]*?<\/think>/i, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/).filter(line => !/^\s*Loading\s+.+(?:\d+%|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s*$/.test(line)).join('\n').trim();
}
function lmsChat(prompt, system) {
  const result = spawnSync(lms, ['chat', 'qwen/qwen3.5-9b', '--prompt', prompt, '--system-prompt', system, '--dont-fetch-catalog'], { cwd: runRoot, encoding: 'utf8', windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`Regia terminal call failed (${result.status ?? result.error?.message ?? 'unknown error'})`);
  return cleanCliText(result.stdout);
}
function runCommand(executable, args, cwd, timeoutMs = 30 * 60 * 1000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { exitCode: result.status ?? -1, error: result.error?.message || null, output: `${result.stdout || ''}\n${result.stderr || ''}`.trim() };
}
async function call(client, name, args, timeout = 60 * 60 * 1000) {
  return parseTool(await client.callTool({ name, arguments: args }, undefined, { timeout }), name);
}
async function lmsUnloadRegia() {
  const processes = runCommand(lms, ['ps'], runRoot, 60000);
  if (processes.exitCode !== 0) throw Error('Could not inspect LM Studio model residency');
  const lines = processes.output.split(/\r?\n/).filter(line => /\b(?:IDLE|GENERATING|LOADING|UNLOADING|FAILED)\b/.test(line));
  const loaded = lines.map(line => line.trim().split(/\s{2,}/).slice(0, 3)).filter(parts => parts.length >= 2);
  const unrelated = loaded.filter(parts => !parts[0].includes('qwen/qwen3.5-9b') && !parts[1].includes('qwen/qwen3.5-9b'));
  if (unrelated.length) throw Error('Another local model is loaded; refusing to disturb it before Coordinator production');
  if (loaded.some(parts => parts[0].includes('qwen/qwen3.5-9b') || parts[1].includes('qwen/qwen3.5-9b'))) {
    const unloaded = runCommand(lms, ['unload', 'qwen/qwen3.5-9b'], runRoot, 120000);
    if (unloaded.exitCode !== 0) throw Error('Could not unload Regia after its terminal turn');
  }
  return processes.output;
}

const systemPath = path.join(lmRoot, 'apps', 'bionic', '.internal', 'user-concrete-model-default-config', 'Qwen', 'qwen3.5-9b.json');
const regiaConfig = JSON.parse(await fs.readFile(systemPath, 'utf8'));
const regiaSystem = regiaConfig.operation.fields.find(field => field.key === 'llm.prediction.systemPrompt')?.value;
if (!regiaSystem) throw Error('Regia system prompt is missing');
const firstRegia = lmsChat(testInput + '\n\nDiscuss this direction as Regia and identify only any essential unresolved creative choice. Do not claim to have saved a file.', regiaSystem);
await fs.writeFile(path.join(runRoot, 'regia-first-turn.md'), firstRegia + '\n');
await record('regia_dialogue', { inputSha256: sha(testInput), outputPath: path.join(runRoot, 'regia-first-turn.md'), outputSha256: sha(firstRegia) });
const simulatedUserAnswer = 'The direction is approved for this test. Keep it a single complete, playable story with a warm comic reveal; let the narrative determine visual moments and audio cue types and loop behavior. Please prepare the English Project File and ask for the production handoff approval.';
const finalRegia = lmsChat(`USER INPUT:\n${testInput}\n\nREGIA'S FIRST TURN (context excerpt):\n${firstRegia.slice(-8000)}\n\nSIMULATED USER ANSWER:\n${simulatedUserAnswer}\n\nNow return the complete canonical Project File body in English Markdown only. Include established character profiles, location and visual continuity, the full story direction and scene beats, a Narrative Production Brief, and an Audio Production Brief. Determine the useful image moments and a modest number of audio cues from the story; do not impose fixed counts. Every audio cue must state category (music or sound effect), loop true/false, description, trigger and stop condition. Include enough implementation direction for a Pixi'VN Visual Novel using Ink. The user has approved the creative direction and production for this test. Do not claim that a file has been written.`, regiaSystem);
await fs.writeFile(path.join(runRoot, 'regia-project-file-draft.md'), finalRegia + '\n');
await record('regia_project_definition', { outputPath: path.join(runRoot, 'regia-project-file-draft.md'), outputSha256: sha(finalRegia), syntheticApproval: simulatedUserAnswer });

const client = new Client({ name: 'bionic-complete-test-harness', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [worker], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: projectWorkspace, BIONIC_ALLOW_COMPLETE_TEST: '1' } });
await client.connect(transport);
const store = new Store(projectWorkspace);
let projectFile;
try {
  const title = `After the Last Broadcast ${runId}`;
  const created = await call(client, 'create_project_file', { project_name: title, initial_content: `## Test Run\n\nRun ID: ${runId}\nSeed: ${seed}\n\n## Regia Creative Direction\n\n${finalRegia}\n\n## Test Scope\n\nThis is a fresh, terminal-driven complete test. Real Coordinator and production MCP workers are authorized for this disposable project. The test harness is the simulated user and has approved the creative direction and production. Do not impose exact story length or fixed visual/audio counts.\n` }, 60000);
  projectFile = created.text?.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!projectFile) throw Error('Project Worker did not return a Project File name');
  const readback = await call(client, 'read_project_file', { filename: projectFile }, 60000);
  if (!readback.text?.includes(finalRegia.slice(0, 100))) throw Error('Project File read-back did not contain Regia output');
  const association = await call(client, 'get_orchestration_status', { filename: projectFile }, 60000);
  let state = await store.read(projectFile);
  await record('project_file_persisted', { projectFile, projectId: state.projectId, sha256: sha(await fs.readFile(store.project(projectFile), 'utf8')), bindingVerified: !!state.binding, terminalAssociation: association });

  const imageClient = new Client({ name: 'image-worker-preflight', version: '1.0.0' });
  const imageTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(lmRoot, 'image-worker', 'mcp', 'server.mjs')], stderr: 'pipe' });
  await imageClient.connect(imageTransport);
  try { await record('image_worker_preflight', parseTool(await imageClient.callTool({ name: 'system_status', arguments: {} }, undefined, { timeout: 60000 }), 'image-worker system_status')); }
  finally { await imageClient.close(); }
  const audioClient = new Client({ name: 'audio-worker-preflight', version: '1.0.0' });
  const audioTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(lmRoot, 'audio', 'mcp', 'server.mjs')], stderr: 'pipe' });
  await audioClient.connect(audioTransport);
  try { await record('audio_worker_preflight', parseTool(await audioClient.callTool({ name: 'system_status', arguments: {} }, undefined, { timeout: 60000 }), 'audio-worker system_status')); }
  finally { await audioClient.close(); }
  await lmsUnloadRegia();

  state = await store.read(projectFile);
  let currentHash = sha(await fs.readFile(store.project(projectFile), 'utf8'));
  const creativeHandoff = await call(client, 'handoff_to_codex', {
    filename: projectFile, production_approved: true,
    approval_text: 'APPROVO PRODUZIONE nel test completo terminale, sulla base della direzione creativa appena definita da Regia.',
    phase: 'single_scene_text_image',
    summary: 'Produce the approved complete story using the configured Hemmingway Writer and Narrative Reviewer; Codex reviews and makes only bounded local corrections; generate and review every useful visual moment declared by the narrative, then publish and transfer all approved images. Preserve the Project File canon and do not set a word count or fixed image quantity.',
    expected_revision: state.revision, expected_sha256: currentHash, execution_mode: 'complete_test'
  });
  manifest.projectFile = projectFile;
  await record('narrative_and_image_phase', creativeHandoff);
  if (creativeHandoff.status !== 'handback_ready' || creativeHandoff.handback?.problems?.length) throw Error('Narrative/image phase did not return a successful handback; see manifest');
  await call(client, 'acknowledge_handback', { filename: projectFile, job_id: creativeHandoff.handback.jobId }, 60000);

  state = await store.read(projectFile);
  currentHash = sha(await fs.readFile(store.project(projectFile), 'utf8'));
  const audioHandoff = await call(client, 'handoff_to_codex', {
    filename: projectFile, production_approved: true,
    approval_text: 'APPROVO la fase audio del test completo secondo i cue e i limiti definiti nel Project File.',
    phase: 'audio_cue_production',
    summary: 'Produce only the audio cues explicitly documented by Regia in the canonical Project File. Reuse suitable project assets first, preserve category/loop/trigger/stop, review all candidates with the real Audio Worker and Codex, and publish successful assets to their configured rclone category paths.',
    expected_revision: state.revision, expected_sha256: currentHash, execution_mode: 'complete_test'
  });
  await record('audio_phase', audioHandoff);
  if (audioHandoff.status !== 'handback_ready' || audioHandoff.handback?.problems?.length) throw Error('Audio phase did not return a successful handback; see manifest');
  await call(client, 'acknowledge_handback', { filename: projectFile, job_id: audioHandoff.handback.jobId }, 60000);

  const allAssets = [...creativeHandoff.handback.assets, ...audioHandoff.handback.assets];
  const localAssets = [];
  for (const source of allAssets) {
    const extension = path.extname(source).toLowerCase();
    const isAudioManifest = /\.(?:wav|ogg|flac)\.json$/i.test(source);
    if (!['.png', '.wav', '.ogg', '.flac'].includes(extension) && !isAudioManifest) continue;
    const category = extension === '.png' ? 'images' : source.toLowerCase().includes(`${path.sep}music${path.sep}`) ? path.join('audio', 'music') : path.join('audio', 'sound-effects');
    const destinationDir = path.join(gameRoot, 'public', 'assets', category);
    await fs.mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, path.basename(source));
    await fs.copyFile(source, destination);
    const buffer = await fs.readFile(destination);
    localAssets.push({ source, destination, bytes: buffer.length, sha256: sha(buffer) });
  }
  await fs.writeFile(path.join(gameRoot, 'test-assets-manifest.json'), JSON.stringify(localAssets, null, 2) + '\n');
  const canonicalPath = store.project(projectFile);
  let canonical = await fs.readFile(canonicalPath, 'utf8');
  canonical += `\n## Complete Test Implementation Target\n\nGame project: ${gameRoot}\n\nCopied verified production assets:\n${localAssets.map(item => `- ${item.destination} (SHA256 ${item.sha256})`).join('\n')}\n`;
  await call(client, 'update_project_file', { filename: projectFile, content: canonical, expected_sha256: sha(await fs.readFile(canonicalPath, 'utf8')) }, 60000);

  const selection = await call(client, 'select_programmer', { filename: projectFile, provider: 'codex', project_root: gameRoot }, 60000);
  await record('programmer_provider_selected', selection);
  if (selection.status !== 'awaiting_explicit_approval') throw Error('Programmer selection did not wait for a separate approval');
  const implementationBrief = `Implement the approved story in the existing Pixi'VN Visual Novel + Ink project at ${gameRoot}. Read the canonical Project File and test-assets-manifest.json. Populate the Ink story with the approved complete narrative and integrate the copied images and audio at their existing paths in the Ink/Pixi'VN project. Preserve story facts, adult character canon, tone, scene order, audio loop behavior and stops. Inspect the generated template, fix project errors necessary for a successful build, and run npm run build. Do not alter files outside this disposable game project.`;
  let programmer = await call(client, 'start_programmer', {
    filename: projectFile, selection_id: selection.selection_id,
    approval_text: 'APPROVO IN MODO SEPARATO l’avvio del Programmatore Codex per implementare il test nel progetto usa e getta Pixi’VN.',
    implementation_brief: implementationBrief
  }, 4 * 60 * 60 * 1000);
  await record('programmer_implementation', programmer);
  if (programmer.status !== 'completed') throw Error('Programmer did not complete the implementation; see manifest');

  let build = runCommand('npm.cmd', ['run', 'build'], gameRoot, 60 * 60 * 1000);
  await fs.writeFile(path.join(runRoot, 'final-build.log'), build.output + '\n');
  await record('final_build', build);
  for (let repair = 1; build.exitCode !== 0 && repair <= 2; repair++) {
    const next = await call(client, 'select_programmer', { filename: projectFile, provider: 'codex', project_root: gameRoot }, 60000);
    const repaired = await call(client, 'start_programmer', { filename: projectFile, selection_id: next.selection_id, approval_text: 'APPROVO in modo separato il passaggio di riparazione del test: correggere gli errori di build registrati.', implementation_brief: `Fix only the current Pixi'VN build errors in ${gameRoot}. The latest build output is at ${path.join(runRoot, 'final-build.log')}. Keep the approved narrative, assets and architecture. Run npm run build and report the result.` }, 4 * 60 * 60 * 1000);
    await record('programmer_build_repair_' + repair, repaired);
    if (repaired.status !== 'completed') break;
    build = runCommand('npm.cmd', ['run', 'build'], gameRoot, 60 * 60 * 1000);
    await fs.writeFile(path.join(runRoot, 'final-build.log'), build.output + '\n');
    await record('final_build_repair_' + repair, build);
  }

  const imageFiles = localAssets.filter(item => path.extname(item.destination).toLowerCase() === '.png');
  const audioFiles = localAssets.filter(item => ['.wav', '.ogg', '.flac'].includes(path.extname(item.destination).toLowerCase()));
  const inkFiles = await fs.readdir(path.join(gameRoot, 'ink')).catch(() => []);
  const report = {
    runId, projectFile, projectId: (await store.read(projectFile)).projectId, projectFileSha256: sha(await fs.readFile(canonicalPath)),
    gameRoot, narrativeAndImageStatus: creativeHandoff.handback.status, audioStatus: audioHandoff.handback.status,
    programmerStatus: programmer.status, buildExitCode: build.exitCode,
    images: imageFiles, audio: audioFiles, inkFiles, acceptance: {
      newInputSeed: Boolean(seed), narrativeProduced: creativeHandoff.handback.assets.some(file => /scene|narrative/i.test(path.basename(file))) || inkFiles.length > 0,
      multipleImages: imageFiles.length > 1, modestAudioSet: audioFiles.length > 0,
      inkProjectPresent: inkFiles.some(name => name.toLowerCase().endsWith('.ink')),
      projectBuildPassed: build.exitCode === 0
    }
  };
  manifest.result = report;
  manifest.status = Object.values(report.acceptance).every(Boolean) ? 'completed' : 'completed_with_gaps';
  manifest.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(runRoot, 'report.md'), `# Complete Pipeline Test\n\n- Run: ${runId}\n- Project File: ${projectFile}\n- Narrative/image: ${report.narrativeAndImageStatus}\n- Audio: ${report.audioStatus}\n- Programmer: ${programmer.status}\n- Build exit code: ${build.exitCode}\n- Images copied: ${imageFiles.length}\n- Audio files copied: ${audioFiles.length}\n- Ink files: ${inkFiles.join(', ') || 'none'}\n- Overall: ${manifest.status}\n`);
  await saveManifest();
  console.log(JSON.stringify({ status: manifest.status, runId, projectFile, gameRoot, reportPath: path.join(runRoot, 'report.md') }, null, 2));
} catch (error) {
  manifest.status = 'error';
  manifest.error = error.message;
  manifest.finishedAt = new Date().toISOString();
  await saveManifest();
  throw error;
} finally { await client.close(); }
