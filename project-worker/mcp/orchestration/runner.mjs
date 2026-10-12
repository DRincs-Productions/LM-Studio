import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store, now, sha, validateHandback } from './core.mjs';
import { MemoryManager, verifyBinding, run } from './bionic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function configuration() { return JSON.parse(await fs.readFile(path.join(here, 'config.json'), 'utf8')); }

export async function executeCodex(store, state, config) {
  const runDir = path.join(store.stateRoot, 'runs', state.job.id);
  await fs.mkdir(runDir, { recursive: true });
  const responsePath = path.join(runDir, 'handback.json');
  const prompt = `You coordinate production for this Bionic project on PC 1.
Canonical English Project File: ${store.project(state.projectFile)}
Project Worker filename argument (basename only): ${state.projectFile}
Stable PROJECT_ID: ${state.projectId}
Operational state: ${store.statePath(state.projectFile)}
Authorized phase: ${state.job.phase}
Operational handoff summary: ${state.job.summary}

Read the Project File before acting. It contains canonical character appearance, clothing, personality, locations, tone and narrative/visual continuity. Preserve these facts and write consolidated project updates in English via Project Worker (use the SHA256 returned by read_project_file to avoid conflicting edits). Do not replace creative decisions that belong to Regia or the user.
Use existing MCPs project-worker, image-worker and asset-worker. PC 2 currently is theoretical; its role is simulated by the local Image Worker. Keep the existing imagecloud: / ImageWorker/final transport. No remote job-dispatch service exists yet. Never claim that a remote PC processed a job. Verify files and transfers before marking a task completed. Do not delete remote images automatically.
If and only if Authorized phase is single_scene_text_image, call project-worker produce_scene_assets once. It runs the Writer → Narrative Reviewer content-only correction loop, then returns a Reviewer-approved draft, presentation checks, review report and source SHA256. Inspect the actual draft and report. Review continuity, characterization, scope, tone, required beats and engagement against the Project File. The Reviewer, not Codex, is responsible for substantive content readiness. Correct presentation defects (headings, directive placement, speaker-label syntax, summary formatting) and only small local prose issues yourself. Preserve strong and unaffected text. The final narrative edit budget is at most 55 changed narrative words and 16% of the narrative; if substantive repairs exceed that, do not rewrite the scene—return a handback explaining the exact content decision or localized Writer repair needed. Do not add unsupported story facts, new scenes, Choice, or extra directives. Preserve exact evidence from the Reviewer PASS for the misunderstanding, spoken minibar clarification, and Alex's comic response. Call project-worker finalize_reviewed_scene once with filename, source_sha256, concise review_summary, changes_made (or explicitly state that no edits were needed), final_check and complete final_narrative. The tool checks the edit budget, content, presentation, evidence and hashes, then writes the final scene and starts Image Controller → Image Worker generation/reviews → finalization → publication → Asset Worker hash-verified transfer. Never generate images before the final narrative tool succeeds. If either tool fails, do not repeat a production stage blindly: inspect the reported EVIDENCE_DIRECTORY and partial artifacts, then return problems and existing effects. Wait for the image/asset tool to finish; total stage may take up to 30 minutes. Read final scene and evidence, then consolidate the English Project File with the Codex-final narrative, Writer/Reviewer and Codex review results, verified image paths, score, transfer hash and production status. Include only verified production artifacts in the handback assets array: absolute narrativePath and transferredPath. Never list the canonical Project File or partial diagnostic files as assets; reference both artifact filenames in the canonical Project File. No sounds/music, Claude or game implementation. The workflow ends with return to Regia. Persistent user approval: ${state.job.approval?.text || 'Not recorded'}.
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
    'asset-worker': ['file_exists', 'fetch_image']
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
      store.update(state.projectFile, s => { if (s.job.id === state.job.id) s.job.codexPid = child.pid; }).then(() => child.stdin.end(prompt)).catch(fail);
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
    if (produced.status !== 'completed' || produced.reviewer !== 'PASS' || produced.codexReview?.status !== 'passed' || produced.codexReview?.checks !== 'passed' || produced.image.score < 80 || produced.image.majorError !== 'NO') throw Error('Production evidence does not support a successful handback');
    const narrativeDirectory = path.dirname(produced.narrativePath);
    const expectedCodexReviewPath = path.join(narrativeDirectory, 'codex-narrative-review.json');
    if (path.resolve(produced.codexReview.path).toLowerCase() !== path.resolve(expectedCodexReviewPath).toLowerCase()) throw Error('Codex review record path does not match the production directory');
    const codexReview = JSON.parse(await fs.readFile(expectedCodexReviewPath, 'utf8'));
    const approvedNarrativeHash = sha(await fs.readFile(produced.narrativePath));
    const reviewedDraftHash = sha(await fs.readFile(path.join(narrativeDirectory, 'narrative-draft.md')));
    if (codexReview.status !== 'passed' || codexReview.checks !== 'passed' || codexReview.finalSha256 !== approvedNarrativeHash || produced.narrativeSha256 !== approvedNarrativeHash || codexReview.sourceSha256 !== reviewedDraftHash || produced.codexReview.finalSha256 !== approvedNarrativeHash) throw Error('Final scene does not match the stored Codex review and Reviewer-approved draft hashes');
    for (const required of [produced.narrativePath, produced.image.transferredPath]) {
      if (!handback.assets.some(asset => path.resolve(asset).toLowerCase() === path.resolve(required).toLowerCase())) throw Error('Successful handback omits a verified production artifact');
    }
    if (sha(await fs.readFile(produced.image.transferredPath)) !== produced.image.sha256) throw Error('Production artifact changed after verification');
    const consolidated = await fs.readFile(store.project(state.projectFile), 'utf8');
    if (!consolidated.includes(path.basename(produced.narrativePath)) || !consolidated.includes(path.basename(produced.image.transferredPath))) throw Error('Project File does not reference the completed narrative and image');
  }
  for (const asset of handback.assets) {
    const resolved = path.resolve(asset);
    if (!(config.writableDirectories || []).some(root => resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep))) throw Error('Reported asset outside configured production roots');
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || !stat.size) throw Error('Reported asset is missing or empty');
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
      const binding = await (adapters.verifyBinding || verifyBinding)(state.binding, state.bindingToken);
      if (sha(await fs.readFile(store.project(filename), 'utf8')) !== state.job.projectSha256) throw Error('Project File changed before coordinator started');
      const gpuBefore = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']).catch(() => null);
      const memory = config.suspendRegia ? await (adapters.memory || new MemoryManager()).suspend(binding) : { status: 'disabled' };
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



