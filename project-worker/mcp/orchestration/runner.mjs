import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store, now, sha, validateHandback } from './core.mjs';
import { MemoryManager, verifyBinding, run } from './bionic.mjs';
import { verifyCodexRelay } from './regia-relay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function configuration() { return JSON.parse(await fs.readFile(path.join(here, 'config.json'), 'utf8')); }

export async function executeCodex(store, state, config) {
  const runDir = path.join(store.stateRoot, 'runs', state.job.id);
  await fs.mkdir(runDir, { recursive: true });
  const responsePath = path.join(runDir, 'handback.json');
const prompt = `You coordinate production for this Bionic project on the local PC.
Canonical English Project File: ${store.project(state.projectFile)}
Project Worker filename argument (basename only): ${state.projectFile}
Stable PROJECT_ID: ${state.projectId}
Operational state: ${store.statePath(state.projectFile)}
Authorized phase: ${state.job.phase}
Operational handoff summary: ${state.job.summary}

Read the Project File before acting. It contains canonical character appearance, clothing, personality, locations, tone and narrative/visual continuity. Preserve these facts and write consolidated project updates in English via Project Worker (use the SHA256 returned by read_project_file to avoid conflicting edits). Do not replace creative decisions that belong to Regia or the user.
Use existing MCPs project-worker, image-worker, asset-worker and audio-worker when authorized by the phase. PC cloud currently is theoretical; do not claim that a remote PC processed a job. Keep the existing rclone transport and category-separated destinations. Verify files and transfers before marking a task completed. Do not delete remote assets automatically.
If and only if Authorized phase is single_scene_text_image, call project-worker produce_scene_assets once. It runs the Writer → Narrative Reviewer content-only correction loop, then returns a Reviewer-approved draft, presentation checks, review report and source SHA256. Inspect the draft and report against the Project File: canon, continuity, requested beats, character motivation, tone and scope. The Reviewer decides narrative readiness; you may repair formatting and small local issues while preserving unaffected prose. Do not impose a word count or fixed counts of scenes, images, or audio cues. Do not invent facts, new scenes, choices or directives not supported by the approved brief. Preserve exact NARRATIVE_EVIDENCE quotes from the Reviewer PASS. Call project-worker finalize_reviewed_scene once with filename, source_sha256, review_summary, changes_made, final_check and complete final_narrative. The worker checks hashes, content evidence and presentation, writes the final narrative, then plans each > Visual: directive and calls Image Worker generation/review/finalization/publication plus Asset Worker hash-verified transfer. Never generate images before final narrative succeeds. If a stage fails, inspect EVIDENCE_DIRECTORY and partial artifacts; do not replay blindly. Read final artifacts/evidence, update the English Project File using its current SHA256, and return only verified asset paths in the handback.
If and only if Authorized phase is audio_cue_production, do not call the scene/image production tools. Read the Project File's Audio Production Brief and process only cue specifications explicitly recorded there. For each cue, first call audio-worker find_project_audio_assets with PROJECT_ID and category. Compare existing candidate manifests/descriptions with the approved cue; reuse an existing approved published asset only when category, loop behavior and creative fit match, and verify its file plus manifest/hash. If no suitable existing asset exists, generate it. Select stable_audio_medium for music and stable_audio_small_sfx for sound effects. Preserve cue category, trigger, stop condition and loop flag from the Project File. Make no more than 3 generation attempts per cue. For each candidate, call inspect_audio then review_audio so Qwen2.5 Omni locally listens and returns evidence only. For loop cues, create a raw repeated preview spanning the generated file (start 0, end its actual duration, repeats 3, crossfade 0) and send that preview to review_audio with loop_preview=true; also review the original candidate for semantic fit. Codex must compare the local listening evidence and technical inspection to the brief, assign 0–100, and identify any major error; only score >=80 and no major error can pass. On failure, preserve the candidate and retry with a precise prompt correction; never overwrite prior candidates. For a passing new candidate, call finalize_audio with the exact local perception report and Codex review (score, major_error=false, concise evidence summary); then call publish_audio. Publish only reviewed cues. Keep Music and SoundEffects separate. Record every cue's status, attempts, final local WAV and manifest paths, SHA256, remote rclone path and any reuse in the English Project File with the SHA256 from read_project_file. If any cue cannot pass, stop that cue after three attempts, record the failure and return an error handback; never claim the whole phase succeeded. Include only verified final WAV and manifest paths in handback assets. Do not modify narrative or images in this audio-only phase. No Claude or game implementation. Persistent user approval: ${state.job.approval?.text || 'Not recorded'}.
For audio_cue_production, reuse an existing asset only when its search result shows status=published, codex_review_score >=80, codex_major_error=false, matching category and matching loop behavior; verify the listed hash and manifest. Persist every new-candidate Codex score and retry decision with record_codex_audio_review. Audio review approval is limited to score >=80 with no major error. A loop cue additionally requires saved Qwen evidence for the real repeated-loop preview. Pass those exact saved evidence paths to finalize_audio; do not substitute a report from another audio hash.
Do only work justified by the phase and canonical file. Do not invent a production request when the project remains under creative definition. If a decision is needed, finish the handback immediately. You are the operational coordinator; Regia continues the creative conversation in the user's language.
No changes to Bionic databases, application bundles, credentials, MCP configuration or installed models. Do not call handoff_to_codex recursively, acknowledge Regia's handback, or edit orchestration state directly. No secrets in outputs or logs.
Return a concise structured handback matching the provided schema: summary, completedTasks, verified asset paths, problems, decisions, questionForUser. The runner persists it and the native pending MCP call returns it to the same Regia session. Orchestration status remains running while you coordinate and until your final response is persisted; this is expected and is not an error or missing handback. The runner, not the coordinator, finalizes operational ownership. Do not try to inject a user message into Bionic. Use terminal commands and MCP tools only; never use GUI, browser or computer automation.
`;
  await fs.writeFile(path.join(runDir, 'request.txt'), prompt, { flag: 'wx' });
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', '--color', 'never',
    '--output-schema', path.join(here, 'handback.schema.json'), '--output-last-message', responsePath,
    '--cd', path.dirname(store.root)];
  for (const directory of config.writableDirectories || []) args.push('--add-dir', directory);
  // Per-run allowlists for the existing, user-authorized production Workers.
  // Exclude recursive handoffs, acknowledgements and remote deletion.
  const workerTools = {
    'project-worker': ['read_project_file', 'update_project_file', 'get_orchestration_status', 'produce_scene_assets', 'finalize_reviewed_scene'],
    'image-worker': ['system_status', 'generate_image', 'file_exists', 'review_with_codex', 'finalize_image', 'publish_image'],
    'asset-worker': ['file_exists', 'fetch_image'],
    'audio-worker': ['system_status', 'find_project_audio_assets', 'generate_audio', 'inspect_audio', 'create_loop_preview', 'review_audio', 'record_codex_audio_review', 'finalize_audio', 'publish_audio']
  };
  for (const [server, names] of Object.entries(workerTools)) {
    args.push('-c', `mcp_servers.${server}.enabled_tools=${JSON.stringify(names)}`);
    args.push('-c', `mcp_servers.${server}.tool_timeout_sec=2100`);
    for (const name of names) args.push('-c', `mcp_servers.${server}.tools.${name}.approval_mode="approve"`);
  }
  args.push('-c', `mcp_servers.project-worker.env.BIONIC_PROJECTS_DIR=${JSON.stringify(store.root)}`);
  if (process.env.BIONIC_LM_ROOT) args.push('-c', `mcp_servers.project-worker.env.BIONIC_LM_ROOT=${JSON.stringify(process.env.BIONIC_LM_ROOT)}`);
  if (config.writerModelIdentifier) args.push('-c', `mcp_servers.project-worker.env.BIONIC_WRITER_MODEL_ID=${JSON.stringify(config.writerModelIdentifier)}`);
  args.push('-c', 'mcp_servers.node_repl.enabled=false');
  args.push('-');
  await new Promise((resolve, reject) => {
    const child = spawn(config.coordinatorCommand, args, { cwd: path.dirname(store.root), shell: false, windowsHide: true });
    let buffer = '', settled = false;
    const timer = setTimeout(() => { child.kill(); fail(Error('Coordinator deadline exceeded; inspect outputs before retrying')); }, config.coordinatorTimeoutMs);
    const fail = e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
    child.on('error', () => fail(Error('Coordinator executable unavailable')));
    child.stderr.on('data', () => {}); // Never persist arbitrary tool or credential output.
    child.stdin.on('error', () => {});
    child.stdout.on('data', d => {
      buffer += d;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            store.update(state.projectFile, s => { if (s.job.id === state.job.id) s.job.codexThreadId = event.thread_id; }).catch(() => {});
          }
        } catch {}
      }
      if (buffer.length > 1024 * 1024) buffer = '';
    });
    child.on('spawn', () => {
      store.update(state.projectFile, s => { if (s.job.id === state.job.id) { s.job.codexPid = child.pid; s.job.codexStartedAt = now(); } }).then(() => child.stdin.end(prompt)).catch(fail);
    });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code !== 0) reject(Error('Coordinator exited with code ' + code + '; inspect outputs before retrying'));
      else resolve();
    });
  });
  const handback = JSON.parse(await fs.readFile(responsePath, 'utf8'));
  validateHandback(handback);
  if (state.job.phase === 'single_scene_text_image' && !handback.problems.length) {
    const resultPath = path.join(process.env.USERPROFILE, '.lmstudio', 'production', state.projectId, state.job.id, 'result.json');
    const produced = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    const images = produced.images?.length ? produced.images : produced.image ? [produced.image] : [];
    if (produced.status !== 'completed' || produced.reviewer !== 'PASS' || produced.codexReview?.status !== 'passed' || produced.codexReview?.checks !== 'passed' || !images.length || images.some(image => image.score < 80 || image.majorError !== 'NO')) throw Error('Production evidence does not support a successful handback');
    const narrativeDirectory = path.dirname(produced.narrativePath);
    const expectedCodexReviewPath = path.join(narrativeDirectory, 'codex-narrative-review.json');
    if (path.resolve(produced.codexReview.path).toLowerCase() !== path.resolve(expectedCodexReviewPath).toLowerCase()) throw Error('Codex review record path does not match the production directory');
    const codexReview = JSON.parse(await fs.readFile(expectedCodexReviewPath, 'utf8'));
    const approvedNarrativeHash = sha(await fs.readFile(produced.narrativePath));
    const reviewedDraftHash = sha(await fs.readFile(path.join(narrativeDirectory, 'narrative-draft.md')));
    if (codexReview.status !== 'passed' || codexReview.checks !== 'passed' || codexReview.finalSha256 !== approvedNarrativeHash || produced.narrativeSha256 !== approvedNarrativeHash || codexReview.sourceSha256 !== reviewedDraftHash || produced.codexReview.finalSha256 !== approvedNarrativeHash) throw Error('Final scene does not match the stored Codex review and Reviewer-approved draft hashes');
    for (const required of [produced.narrativePath, ...images.map(image => image.transferredPath)]) {
      if (!handback.assets.some(asset => path.resolve(asset).toLowerCase() === path.resolve(required).toLowerCase())) throw Error('Successful handback omits a verified production artifact');
    }
    for (const image of images) if (sha(await fs.readFile(image.transferredPath)) !== image.sha256) throw Error('Production artifact changed after verification');
    const consolidated = await fs.readFile(store.project(state.projectFile), 'utf8');
    if (!consolidated.includes(path.basename(produced.narrativePath)) || !consolidated.includes(path.basename(produced.image.transferredPath))) throw Error('Project File does not reference the completed narrative and image');
  }
  for (const asset of handback.assets) {
    const resolved = path.resolve(asset);
    if (!(config.writableDirectories || []).some(root => resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep))) throw Error('Reported asset outside configured production roots');
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || !stat.size) throw Error('Reported asset is missing or empty');
  }
  if (state.job.phase === 'audio_cue_production' && !handback.problems.length) {
    const audioAssets = handback.assets.filter(asset => /\.(wav|flac|ogg)(\.json)?$/i.test(asset));
    const wavs = audioAssets.filter(asset => /\.(wav|flac|ogg)$/i.test(asset));
    if (!wavs.length) throw Error('Successful audio handback contains no verified audio assets');
    const canonical = await fs.readFile(store.project(state.projectFile), 'utf8');
    for (const audioPath of wavs) {
      const manifestPath = `${audioPath}.json`;
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!audioAssets.some(asset => path.resolve(asset).toLowerCase() === path.resolve(manifestPath).toLowerCase())) throw Error('Audio handback omits a finalized audio manifest');
      if (manifest.status !== 'published' || manifest.codex_review?.score < 80 || manifest.codex_review?.major_error !== false) throw Error('Audio manifest does not prove a passing Codex review and publication');
      if (!String(manifest.remote_path || '').startsWith('imagecloud:AudioWorker/')) throw Error('Audio manifest does not contain the configured rclone destination');
      if (sha(await fs.readFile(audioPath)) !== manifest.audio_sha256) throw Error('Final audio changed after review or publication');
      if (!canonical.includes(path.basename(audioPath)) || !canonical.includes(manifest.audio_sha256)) throw Error('Project File does not record the final audio path and hash');
      const categoryDirectory = manifest.category === 'music' ? `${path.sep}Music${path.sep}` : manifest.category === 'sound_effect' ? `${path.sep}SoundEffects${path.sep}` : null;
      if (!categoryDirectory || !audioPath.includes(categoryDirectory)) throw Error('Final audio is not in its category-specific project directory');
    }
  }
  return handback;
}

export async function runJob(store, filename, config, adapters = {}) {
  // One coordinator at a time on PC 1 prevents concurrent GPU ownership.
  return store.locked('coordinator-global.md', async () => {
    let state = await store.read(filename);
    if (state.status !== 'queued') return;
    state = await store.update(filename, s => { s.status = 'running'; s.job.status = 'running'; s.job.runnerPid = process.pid; s.job.startedAt = now(); });
    try {
      const completeTest = state.job.executionMode === 'complete_test';
      if (completeTest && process.env.BIONIC_ALLOW_COMPLETE_TEST !== '1') throw Error('Complete-test runner mode is not enabled by the terminal harness');
      if (state.job.frontend === 'codex' && state.job.relaySessionId !== state.codexRelay?.id) throw Error('Codex relay session changed after handoff');
      const binding = completeTest ? null : state.job.frontend === 'codex'
        ? await verifyCodexRelay(store, state)
        : await (adapters.verifyBinding || verifyBinding)(state.binding, state.bindingToken);
      if (sha(await fs.readFile(store.project(filename), 'utf8')) !== state.job.projectSha256) throw Error('Project File changed before coordinator started');
      const gpuBefore = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']).catch(() => null);
      const memory = completeTest ? { status: 'terminal-test-no-bionic-session' } : config.suspendRegia ? await (adapters.memory || new MemoryManager()).suspend(binding) : { status: 'disabled' };
      const gpuAfter = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']).catch(() => null);
      await store.update(filename, s => { s.job.memory = { ...memory, gpuBeforeMiB: gpuBefore?.code === 0 ? gpuBefore.stdout.trim() : null, gpuAfterMiB: gpuAfter?.code === 0 ? gpuAfter.stdout.trim() : null }; });
      const handback = await (adapters.execute || executeCodex)(store, state, config);
      return await store.finish(filename, state.job.id, handback, handback.problems.length ? 'error' : 'completed');
    } catch (e) {
      return await store.finish(filename, state.job.id, { summary: 'Production requires attention before it can continue.', completedTasks: [], assets: [], problems: [e.message], decisions: ['Inspect the current project and available dependencies.'], questionForUser: 'How should we resolve this production problem?' }, 'error');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  try { await runJob(new Store(), filename, await configuration()); }
  catch (e) {
    const store = new Store();
    await store.ensure();
    await fs.writeFile(path.join(store.stateRoot, 'runner-failure-' + sha(filename) + '.json'), JSON.stringify({ projectFile: filename, error: e.message, timestamp: now() })).catch(() => {});
    process.exitCode = 1;
  }
}



