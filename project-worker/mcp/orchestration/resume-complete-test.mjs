import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, sha } from './core.mjs';

const lmRoot = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.lmstudio');
const rootArg = process.argv.find(value => value.startsWith('--root='))?.slice('--root='.length);
if (!rootArg) throw Error('Usage: node resume-complete-test.mjs --root="C:\\Users\\Shadow\\.lmstudio\\production-tests\\complete\\<run>"');
const runRoot = path.resolve(rootArg);
const approvedRoot = path.join(lmRoot, 'production-tests', 'complete');
if (!runRoot.toLowerCase().startsWith(approvedRoot.toLowerCase() + path.sep)) throw Error('Resume root must stay under .lmstudio/production-tests/complete');
const manifestPath = path.join(runRoot, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.mode !== 'complete' || !['error', 'recovering'].includes(manifest.status)) throw Error('Resume requires a failed or interrupted complete-test manifest');
const projectFile = manifest.stages.find(stage => stage.stage === 'project_file_persisted')?.projectFile;
if (!projectFile) throw Error('Failed run has no recorded Project File');
const projectWorkspace = manifest.projectWorkspace;
const gameRoot = manifest.gameRoot;
if (!projectWorkspace || !gameRoot || !path.resolve(projectWorkspace).toLowerCase().startsWith(runRoot.toLowerCase() + path.sep) || !path.resolve(gameRoot).toLowerCase().startsWith(runRoot.toLowerCase() + path.sep)) throw Error('Manifest project paths are missing or outside the test root');
const store = new Store(projectWorkspace);
const worker = path.join(lmRoot, 'project-worker', 'mcp', 'server.mjs');
const client = new Client({ name: 'bionic-complete-test-recovery', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [worker], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: projectWorkspace, BIONIC_ALLOW_COMPLETE_TEST: '1' } });
await client.connect(transport);
async function save() { await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); }
async function record(stage, data) { manifest.stages.push({ at: new Date().toISOString(), stage, ...data }); await save(); }
function textOf(result) { return (result.content || []).map(item => item.text || '').join('\n'); }
function parseTool(result, name) {
  if (result.isError) throw Error(`${name} returned MCP error: ${textOf(result).slice(0, 1200)}`);
  let value = textOf(result);
  for (let depth = 0; depth < 4; depth++) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { return { text: value }; }
    if (parsed?.content?.length && typeof parsed.content[0].text === 'string') { value = parsed.content.map(item => item.text || '').join('\n'); continue; }
    return parsed;
  }
  return { text: value };
}
async function call(name, args, timeout = 60 * 60 * 1000) { return parseTool(await client.callTool({ name, arguments: args }, undefined, { timeout }), name); }
function runCommand(executable, args, cwd, timeoutMs = 60 * 60 * 1000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { exitCode: result.status ?? -1, error: result.error?.message || null, output: `${result.stdout || ''}\n${result.stderr || ''}`.trim() };
}

manifest.status = 'recovering';
manifest.recoveryStartedAt = new Date().toISOString();
manifest.recoveryNotes ||= [];
delete manifest.error;
delete manifest.finishedAt;
await save();
try {
  const lms = path.join(lmRoot, 'bin', 'lms.exe');
  let apiStatus = runCommand(lms, ['server', 'status'], runRoot, 60000);
  if (/server is not running/i.test(apiStatus.output)) {
    const started = runCommand(lms, ['server', 'start'], runRoot, 60000);
    if (started.exitCode !== 0 || !/server is now running on port 1234/i.test(started.output)) throw Error('Could not start the LM Studio API server for recovery');
    apiStatus = runCommand(lms, ['server', 'status'], runRoot, 60000);
  }
  if (apiStatus.exitCode !== 0 || !/server is running on port 1234/i.test(apiStatus.output)) throw Error('LM Studio API server is not ready for recovery');
  await record('lm_studio_api_preflight', { status: 'running', output: apiStatus.output });

  let state = await store.read(projectFile);
  if (!['error', 'interrupted'].includes(state.handback?.status) || state.handback?.jobId !== state.job?.id || !['handback_ready', 'regia_ready'].includes(state.status)) throw Error('Project Worker state does not match the failed or interrupted handback; refusing to replay');
  await record('recovery_previous_handback', { jobId: state.handback.jobId, status: state.handback.status, problems: state.handback.problems });
  if (state.status === 'handback_ready') await call('acknowledge_handback', { filename: projectFile, job_id: state.handback.jobId }, 60000);
  else if (!state.handback.acknowledgedAt) throw Error('Regia-ready state has no acknowledged failed handback; refusing to continue');

  const projectPath = store.project(projectFile);
  let content = await fs.readFile(projectPath, 'utf8');
  const recoveryNote = `### Complete-Test Canon Clarification — ${new Date().toISOString()}\n\nThis disposable test clarification overrides every conflicting alternative in this Project File. There is exactly ONE private recording and ONE playback. At 3:08 a.m. Tali records the complete voice memo “Ivo, come see the orchid at dawn. Bring coffee.” She saves it without previewing, playing or listening to it. At 3:14 a.m. the buffer plays that recording exactly once with the live clock visible; Tali alone hears it. She never replays, sends or shares it; Ivo never hears or receives it and does not know its content. At exactly 3:18 a.m., four minutes after playback, the scheduler commits one metadata-only log row: capture_time=03:08, replay_time=03:14, scheduler_label=03:18, label_source=processed_at. The row contains no message body, transcript, payload or recipient. The bug is that the 3:18 processing/commit time is put in a field presented as the clip's event time. The timeline math is fixed: recording to playback is six minutes; recording to label is ten minutes; playback to label is four minutes. At 3:18 the recording is ten minutes old, not six. There is no future transmission, second message, prior-day recording, preview, other playback, alternate technical mechanism, supernatural cause or other anomaly.\n\nAt 3:18 a.m. Ivo independently arrives on the rooftop access pathway during his ordinary overnight radio-engineering shift; his arrival has nothing to do with the private recording. Tali Rook (29) and Ivo Senn (33) meet and begin their first personal conversation on that pathway in this same 3:18 scene. Explicitly state this meeting location; the greenhouse, radio station, booth, hatch, console and stairwell are not where they first meet. Before this moment they have never seen, heard, spoken with, messaged, monitored, or otherwise interacted with one another; neither recognizes the other's voice, and neither has spoken about the other. Each knows only the other's name and job from work records. Tali may show Ivo only the four metadata fields. She does not reveal the memo's words. Tali explicitly invites him in person to stay with her and see the unidentified orchid open at dawn; Ivo agrees and already has his ordinary shift coffee. Do not imply past familiarity, shared history, prior voice exposure, or a conversation already in progress. The first meeting is at the pathway, not inside the radio station. Tali wears her canonical green utility jacket, dark clothes, gloves and rooftop boots. Ivo has light brown/dark blonde tousled hair, steel-gray eyes, a dark work shirt and headset around his neck. Do not invent other appearance facts. The flower is an unidentified rare orchid, and no prior bloom or growth history is established. Do not invent or name a species, bloom count, arrival date, how long it has been closed, whether anyone has seen it open before, collection status, precise opening time, remaining duration, internal glow, or other biology. At dawn, keep Tali and Ivo together and show the orchid petals actually opening on-page; the story must include this shared event before it ends, not stop at anticipation. Ivo must explicitly accept Tali’s invitation in spoken dialogue. Do not add any other character or setting facts that conflict with the Project File.\n\n`;
  const marker = '## VISUAL MOMENT DECISIONS';
  if (!content.includes(marker)) throw Error('Project File has no story structure insertion point for test clarification');
  const currentHash = sha(content);
  const clarificationMarker = '### Complete-Test Canon Clarification';
  if (content.includes(clarificationMarker)) {
    const start = content.indexOf(clarificationMarker);
    const end = content.indexOf(marker, start);
    if (end < 0) throw Error('Could not find the end of the existing test clarification');
    content = content.slice(0, start) + recoveryNote + content.slice(end);
  } else content = content.replace(marker, recoveryNote + marker);
  const anomalyHeading = '### NATURE OF TIME ANOMALY (RESOLVED)';
  const actHeading = '### ACT STRUCTURE';
  const anomalyStart = content.indexOf(anomalyHeading);
  const actStart = content.indexOf(actHeading, anomalyStart + anomalyHeading.length);
  if (anomalyStart < 0 || actStart < 0) throw Error('Could not locate the ambiguous anomaly canon for correction');
  const anomalyCanon = `${anomalyHeading}
**Only explanation:** There is no future transmission. Tali makes exactly one private recording and does not preview or listen to it at 3:08. At 3:08 a.m. she records: “Ivo, come see the orchid at dawn. Bring coffee.” At 3:14 a.m. the buffer plays that complete recording exactly once with the live clock visible; Tali alone hears it. She never replays, sends or shares it; Ivo never hears or receives it and does not know its content. At exactly 3:18 a.m., four minutes after playback, the scheduler commits one metadata-only event-log row: capture_time=03:08, replay_time=03:14, scheduler_label=03:18, label_source=processed_at. The row contains no message body, transcript, payload or recipient. Its bug is putting its 3:18 processing/commit time in a field presented as the clip's event time. Correctly state six minutes from recording to playback, ten minutes from recording to label, and four minutes from playback to label. At 3:18 the recording is ten minutes old, not six. No preview, second recording, prior-day recording, other playback, supernatural cause or alternate mechanism.

#### REQUIRED STORY TIMELINE
- 3:08 a.m.: Tali records the private voice memo: “Ivo, come see the orchid at dawn. Bring coffee.” She saves it without preview or playback.
- 3:14 a.m.: The buffer plays the complete private recording exactly once; show the live clock. Tali alone hears it. No further playback or sharing occurs.
- 3:18 a.m.: Exactly four minutes after playback, the scheduler commits one metadata-only row showing capture_time=03:08, replay_time=03:14, scheduler_label=03:18, label_source=processed_at; Tali and Ivo explicitly calculate six, ten and four minutes and identify the processing-time/event-time bug. Ivo independently arrives during his ordinary overnight shift, with no prior contact or knowledge of the recording. He and Tali begin their first conversation on the rooftop access pathway. Tali explicitly invites Ivo in person to stay for dawn; he agrees and already has his ordinary shift coffee.
- Dawn: Keep Tali and Ivo together and show the unidentified rare orchid visibly opening on its ordinary schedule. End after this shared event; do not name its species, invent any prior bloom/growth history, set a clock time/duration, or invent flower biology. Ivo explicitly accepts the invitation aloud before they wait.

**Relationship boundary:** Tali and Ivo begin their first personal conversation at the rooftop access pathway at 3:18 a.m. Before this moment they have never seen, heard, spoken with, messaged, or interacted with one another; neither recognizes the other's voice, and neither has spoken about the other. Each knows only the other's name and job from work records. Ivo arrives on routine shift business, not because he received or heard Tali's private recording. The log he sees contains only the four timestamp/source fields above. Tali explicitly invites him in person to stay for the orchid's ordinary dawn opening; he accepts. Do not imply earlier familiarity, shared history, prior voice exposure or a conversation already in progress. Tali wears her canonical green utility jacket, dark clothes, gloves and rooftop boots. Ivo has light brown/dark blonde tousled hair, steel-gray eyes, a dark work shirt and headset around his neck. The flower is an unidentified rare orchid with no established prior bloom or growth history. Build the romance through this first encounter and their shared wait, with Ivo’s spoken acceptance and the actual flower opening shown before the narrative ends.

`;
  content = content.slice(0, anomalyStart) + anomalyCanon + content.slice(actStart);
  content = content.replace('- Setting: Radio booth, 2:30 AM', '- Setting: Greenhouse and radio booth, 3:08–3:18 AM; preserve the Required Story Timeline exactly.');
  content = content.replace(/- Event: Tali explains she made recordings for testing purposes; message was accidental capture or playback artifact\s*/i, '- Event: Tali records the exact message at 3:08; the same clip replays at 3:14; they diagnose its incorrect 3:18 scheduler label from the event log.\n');
  content = content.replace(/- Event: Strange transmission arrives; audio signature matches Tali's voice but timestamp is wrong\s*/i, '- Event: Tali records the exact message at 3:08; the same clip replays at 3:14; they diagnose its incorrect 3:18 scheduler label from the event log.\n');
  if (content !== await fs.readFile(projectPath, 'utf8')) {
    const update = await call('update_project_file', { filename: projectFile, content, expected_sha256: currentHash }, 60000);
    if (!/^PROJECT_FILE_UPDATED\b/m.test(update.text || '')) throw Error('Project Worker did not confirm the recovery note update');
  }
  const readback = await call('read_project_file', { filename: projectFile }, 60000);
  if (!readback.text?.includes('capture_time=03:08, replay_time=03:14, scheduler_label=03:18')) throw Error('Recovery clarification failed read-back verification');
  await record('test_spec_clarification', { details: 'Resolved the grounded signal mechanism, first-meeting continuity, and flower timing in the disposable test Project File; preserved all previous narratives and evidence.' });

  const residency = runCommand(lms, ['ps'], runRoot, 60000);
  if (residency.exitCode !== 0 || !/No models are currently loaded/i.test(residency.output)) throw Error('Local model memory is occupied before recovery; leave the loaded model untouched and retry when it is free');
  await record('local_model_memory_preflight', { status: 'free' });

  state = await store.read(projectFile);
  let projectHash = sha(await fs.readFile(projectPath, 'utf8'));
  const creative = await call('handoff_to_codex', {
    filename: projectFile, production_approved: true,
    approval_text: 'APPROVO la ripresa autonoma del test completo, limitata alla correzione del prompt immagine e al completamento delle fasi rimaste.',
    phase: 'single_scene_text_image',
    summary: 'Continue the approved disposable complete test from the latest interrupted handback using the exact canon in the Project File. Tali records one private memo at 3:08 and saves it without preview/listening; the buffer plays it once at 3:14 with the live clock, heard only by Tali. Exactly at 3:18, four minutes later, the scheduler commits the one metadata-only row capture_time=03:08, replay_time=03:14, scheduler_label=03:18, label_source=processed_at. State the 6-, 10- and 4-minute differences explicitly; at 3:18 the recording is ten minutes old. Ivo independently arrives for routine overnight engineering work, has no prior contact and never receives/hears/knows the memo. They first meet and talk at the rooftop access pathway at 3:18. Tali explicitly invites him in person to stay for the orchid opening at dawn; he agrees and already has his own routine shift coffee. Ivo has light brown/dark blonde hair, steel-gray eyes, dark work shirt and headset around neck; Tali has canonical green jacket, dark clothes, gloves and rooftop boots. Orchid species remains unidentified; no prior bloom or growth history is established. Do not invent bloom count, arrival date, how long it was closed, prior observations, collection status, precise opening time, remaining duration, internal glow or biology. Ivo explicitly accepts aloud, and the narrative shows Tali and Ivo together as the orchid petals actually open at dawn before it ends. Writer and Reviewer correct these facts, then Codex independently reviews and makes only bounded final edits. After approval, produce, review, publish and transfer narrative-driven images and canon audio cues. Preserve all previous drafts, jobs, rejected assets and evidence; do not impose fixed asset counts.',
    expected_revision: state.revision, expected_sha256: projectHash, execution_mode: 'complete_test'
  });
  await record('recovery_narrative_image_phase', creative);
  if (creative.status !== 'handback_ready' || creative.handback?.problems?.length) throw Error('Recovered narrative/image phase did not succeed; see its handback in manifest');
  await call('acknowledge_handback', { filename: projectFile, job_id: creative.handback.jobId }, 60000);

  state = await store.read(projectFile);
  projectHash = sha(await fs.readFile(projectPath, 'utf8'));
  const audio = await call('handoff_to_codex', {
    filename: projectFile, production_approved: true,
    approval_text: 'APPROVO la produzione audio del test completo secondo i cue canonici del Project File.',
    phase: 'audio_cue_production',
    summary: 'Produce only audio cues explicitly specified by Regia. Reuse suitable project audio assets first; preserve music/SFX, loop, trigger and stop behavior. Have the Audio Worker listen and Codex review each cue; publish only passing assets to the existing rclone destinations.',
    expected_revision: state.revision, expected_sha256: projectHash, execution_mode: 'complete_test'
  });
  await record('recovery_audio_phase', audio);
  if (audio.status !== 'handback_ready' || audio.handback?.problems?.length) throw Error('Audio phase did not succeed; see its handback in manifest');
  await call('acknowledge_handback', { filename: projectFile, job_id: audio.handback.jobId }, 60000);

  const allAssets = [...(creative.handback.assets || []), ...(audio.handback.assets || [])];
  const localAssets = [];
  for (const source of allAssets) {
    const extension = path.extname(source).toLowerCase();
    const audioManifest = /\.(?:wav|ogg|flac)\.json$/i.test(source);
    if (!['.png', '.wav', '.ogg', '.flac'].includes(extension) && !audioManifest) continue;
    const category = extension === '.png' ? 'images' : source.toLowerCase().includes(`${path.sep}music${path.sep}`) ? path.join('audio', 'music') : path.join('audio', 'sound-effects');
    const destinationDir = path.join(gameRoot, 'public', 'assets', category);
    await fs.mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, path.basename(source));
    await fs.copyFile(source, destination);
    const buffer = await fs.readFile(destination);
    localAssets.push({ source, destination, bytes: buffer.length, sha256: sha(buffer) });
  }
  await fs.writeFile(path.join(gameRoot, 'test-assets-manifest.json'), JSON.stringify(localAssets, null, 2) + '\n');
  content = await fs.readFile(projectPath, 'utf8');
  const assetNote = `\n\n## Complete Test Implementation Target\n\nGame project: ${gameRoot}\n\nCopied verified production assets:\n${localAssets.map(item => `- ${item.destination} (SHA256 ${item.sha256})`).join('\n')}\n`;
  const assetUpdate = await call('update_project_file', { filename: projectFile, content: content + assetNote, expected_sha256: sha(content) }, 60000);
  if (!/^PROJECT_FILE_UPDATED\b/m.test(assetUpdate.text || '')) throw Error('Project Worker did not confirm the asset manifest update');
  const assetReadback = await call('read_project_file', { filename: projectFile }, 60000);
  if (!assetReadback.text?.includes('Copied verified production assets:')) throw Error('Asset paths failed Project File read-back verification');

  const selection = await call('select_programmer', { filename: projectFile, provider: 'codex', project_root: gameRoot }, 60000);
  await record('programmer_provider_selected', selection);
  if (selection.status !== 'awaiting_explicit_approval') throw Error('Programmer selection did not wait for a separate approval');
  const brief = `Implement the approved story in the existing Pixi'VN Visual Novel + Ink project at ${gameRoot}. Read the canonical Project File and test-assets-manifest.json. Populate the Ink story with the approved complete narrative and integrate copied image/audio assets at their paths. Preserve story facts, canon, tone, scene order, audio loop and stop behavior. Fix template errors needed for a successful build. Do not modify files outside this disposable game project.`;
  let programmer = await call('start_programmer', { filename: projectFile, selection_id: selection.selection_id, approval_text: 'APPROVO in modo separato l’avvio del Programmatore Codex per completare il test usa e getta.', implementation_brief: brief }, 4 * 60 * 60 * 1000);
  await record('programmer_implementation', programmer);
  if (programmer.status !== 'completed') throw Error('Programmer did not complete; see manifest');

  let build = runCommand('npm.cmd', ['run', 'build'], gameRoot);
  await fs.writeFile(path.join(runRoot, 'final-build.log'), build.output + '\n');
  await record('final_build', build);
  for (let attempt = 1; build.exitCode !== 0 && attempt <= 2; attempt++) {
    const next = await call('select_programmer', { filename: projectFile, provider: 'codex', project_root: gameRoot }, 60000);
    const repaired = await call('start_programmer', { filename: projectFile, selection_id: next.selection_id, approval_text: 'APPROVO separatamente la riparazione del build nel progetto temporaneo del test.', implementation_brief: `Fix only the current build errors in ${gameRoot}. Read ${path.join(runRoot, 'final-build.log')}, preserve approved story/assets, and run npm run build.` }, 4 * 60 * 60 * 1000);
    await record(`programmer_build_repair_${attempt}`, repaired);
    if (repaired.status !== 'completed') break;
    build = runCommand('npm.cmd', ['run', 'build'], gameRoot);
    await fs.writeFile(path.join(runRoot, 'final-build.log'), build.output + '\n');
    await record(`final_build_repair_${attempt}`, build);
  }

  const imageFiles = localAssets.filter(item => path.extname(item.destination).toLowerCase() === '.png');
  const audioFiles = localAssets.filter(item => ['.wav', '.ogg', '.flac'].includes(path.extname(item.destination).toLowerCase()));
  const inkFiles = await fs.readdir(path.join(gameRoot, 'ink')).catch(() => []);
  const report = {
    runId: manifest.runId, projectFile, projectId: (await store.read(projectFile)).projectId,
    projectFileSha256: sha(await fs.readFile(projectPath)), gameRoot,
    narrativeAndImageStatus: creative.handback.status, audioStatus: audio.handback.status,
    programmerStatus: programmer.status, buildExitCode: build.exitCode,
    images: imageFiles, audio: audioFiles, inkFiles,
    previousFailedJob: manifest.stages.find(stage => stage.stage === 'recovery_previous_handback')?.jobId,
    acceptance: {
      freshInputSeed: Boolean(manifest.seed), narrativeProduced: creative.handback.assets.some(file => /scene|narrative/i.test(path.basename(file))) || inkFiles.length > 0,
      multipleImages: imageFiles.length > 1, audioProduced: audioFiles.length > 0,
      inkProjectPresent: inkFiles.some(name => name.toLowerCase().endsWith('.ink')),
      projectBuildPassed: build.exitCode === 0
    }
  };
  manifest.result = report;
  manifest.status = Object.values(report.acceptance).every(Boolean) ? 'completed' : 'completed_with_gaps';
  manifest.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(runRoot, 'report.md'), `# Complete Pipeline Test — Recovery\n\n- Run: ${manifest.runId}\n- Project File: ${projectFile}\n- Failed attempt retained; recovered image prompt then ran the remaining phases\n- Narrative/image: ${report.narrativeAndImageStatus}\n- Audio: ${report.audioStatus}\n- Programmer: ${programmer.status}\n- Build exit code: ${build.exitCode}\n- Images copied: ${imageFiles.length}\n- Audio files copied: ${audioFiles.length}\n- Ink files: ${inkFiles.join(', ') || 'none'}\n- Overall: ${manifest.status}\n`);
  await save();
  console.log(JSON.stringify({ status: manifest.status, runId: manifest.runId, projectFile, gameRoot, reportPath: path.join(runRoot, 'report.md') }, null, 2));
} catch (error) {
  manifest.status = 'error'; manifest.error = error.message; manifest.finishedAt = new Date().toISOString();
  manifest.recoveryNotes.push({ at: manifest.finishedAt, error: error.message });
  await save();
  throw error;
} finally { await client.close(); }



