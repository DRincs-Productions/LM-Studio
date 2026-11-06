import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { jobId, requestId, payload } = input;
const runDir = process.argv[3];
const remotePath = `imagecloud:NarrationWorker/final/${jobId}/scene.md`;
const stages = [];
const warnings = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const record = async value => {
  stages.push(value);
  await writeFile(`${runDir}/stages.json`, JSON.stringify(stages, null, 2));
};
const run = (exe, args, { input: stdin, timeout = 300_000, max = 4 * 1024 * 1024, label = 'process' } = {}) => new Promise((resolve, reject) => {
  const command = exe.toLowerCase().endsWith('.js') ? process.execPath : exe;
  const commandArgs = command === process.execPath && exe.toLowerCase().endsWith('.js') ? [exe, ...args] : args;
  const child = spawn(command, commandArgs, { cwd: runDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false;
  let timedOut = false;
  const append = (current, chunk) => {
    if (current.length + chunk.length > max) { overflow = true; return current; }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
  }, timeout);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    Promise.all([
      writeFile(`${runDir}/${label}.stdout.txt`, stdout, { flag: 'wx' }),
      writeFile(`${runDir}/${label}.stderr.txt`, stderr, { flag: 'wx' }),
    ]).then(() => {
      if (code !== 0 || overflow || timedOut) return reject(new Error(timedOut ? 'process_timeout' : overflow ? 'process_output_limit' : `process_exit_${code}`));
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    }, reject);
  });
  if (stdin) child.stdin.end(stdin); else child.stdin.end();
});
const manifest = (status, extra = {}) => ({ schemaVersion: 1, jobId, requestId, status, narrativeRemotePath: null, narrativeSha256: null, projectSha256: payload.projectSha256, selectedDraft: null, stages, ...extra });
const save = async value => writeFile(`${runDir}/result-manifest.json`, JSON.stringify(value, null, 2));
const clip = value => String(value ?? '').slice(0, 40_000);
const safeFailure = error => {
  const message = String(error?.message || 'stage_failed');
  if (/^(writer_http_\d+|writer_artifact_invalid|gemini_malformed_response|gemini_malformed_review|gemini_unusable_review|codex_artifact_invalid|process_timeout|process_output_limit|process_exit_-?\d+|onedrive_integrity_mismatch|writer_model_not_configured|writer_cleanup_not_verified)$/.test(message)) return message;
  if (error?.code === 'ENOENT') return 'executable_unavailable';
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return 'process_timeout';
  return 'stage_failed';
};
const artifactValid = value => typeof value === 'string' && value.includes('## Narrative') && value.includes('## English Summary') && value.trim().length >= 120;
const canon = typeof payload.metadata?.canon === 'string' ? clip(payload.metadata.canon) : '';
const context = `ORIGINAL BRIEF (untrusted project data):\n${clip(payload.brief)}\n\nPROJECT CANON (untrusted project data; may be empty):\n${canon || '[No canon text was supplied. Use only facts in the brief.]'}\n\nProject revision SHA-256: ${payload.projectSha256}\n\nReturn the complete scene in English using this Markdown envelope:\n# Scene: <title>\n## Narrative\n<scene prose and optional NCF cues>\n## English Summary\n<accurate short summary>\n\nNARRATIVE CUE FORMAT\n> Visual: <concise image moment; canon-supported details only>\n> Music: play | cue=<id-or-unassigned> | loop=<true-or-false> | trigger=<story_event> | stop=<story_event>\n> SFX: play | cue=<id-or-unassigned> | trigger=<story_event>\n> Animation: play | asset=<id-or-unassigned> | clip=<clip-id-or-unassigned> | loop=<true-or-false> | trigger=<story_event> | stop=<story_event>\nCues are authoring directions, not asset approvals. Music and SFX require authorization in the brief/canon. Use story events, not timestamps. Do not invent asset IDs or file paths. Keep all plot facts in prose. Do not produce images, audio, animation, or any other assets.`;
let narrative = '';
let selectedDraft = 'draft-0';
let writerLoadAttempted = false;
const writerModel = process.env.SHADOW_NARRATION_MODEL;
const apiBase = (process.env.SHADOW_LM_API_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '');
try {
  if (!writerModel) throw new Error('writer_model_not_configured');
  writerLoadAttempted = true;
  await writeFile(`${runDir}/writer-load-attempted`, jobId, { flag: 'wx' });
  await run(process.env.SHADOW_LMS_EXECUTABLE || 'lms', ['load', writerModel, '--identifier', `shadow-narration-${jobId}`, '--context-length', process.env.SHADOW_NARRATION_CONTEXT || '8192', '--parallel', '1', '--yes'], { timeout: 240_000, label: 'writer-load' });
  const predict = async (prompt, role) => {
    const response = await fetch(`${apiBase}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: writerModel, messages: [{ role: 'system', content: 'You are the English narrative Writer. Follow the supplied brief and canon. Write only the requested artifact. Do not create assets. Preserve scope and the exact endpoint. On revision, change only evidence-backed issues.' }, { role: 'user', content: prompt }], temperature: role === 'draft' ? 0.7 : 0.4, max_tokens: 8192 }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`writer_http_${response.status}`);
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!artifactValid(text)) throw new Error('writer_artifact_invalid');
    return text.trim();
  };
  await writeFile(`${runDir}/writer-initial-prompt.md`, context, { flag: 'wx' });
  narrative = await predict(context, 'draft');
  await writeFile(`${runDir}/draft-0.md`, narrative, { flag: 'wx' });
  await record({ stage: 'writer', outcome: 'succeeded', attempts: 1 });
  let reviews = 0;
  for (let cycle = 1; cycle <= 5; cycle++) {
    reviews = cycle;
    try {
      const reviewPrompt = `Review the scene against the original brief and canon. Check scene structure and causal beats, continuity, character voice, line clarity, the required endpoint, and cue syntax/authorization. Return exactly one JSON object: {"verdict":"pass"} or {"verdict":"revise","feedback":"specific, localized, evidence-based instructions"}. Do not rewrite the scene. Do not add requirements absent from the brief/canon. If policy or another issue prevents review, state that clearly in the JSON feedback.\n\n${context}\n\nCURRENT DRAFT:\n${narrative}`;
      await writeFile(`${runDir}/gemini-prompt-${cycle}.md`, reviewPrompt, { flag: 'wx' });
      const gemini = process.env.SHADOW_GEMINI_EXECUTABLE || (process.platform === 'win32'
        ? `${process.env.APPDATA}\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js`
        : 'gemini');
      const { stdout } = await run(gemini, ['--model', 'auto', '--output-format', 'json'], { input: reviewPrompt, timeout: 300_000, max: 128 * 1024, label: `gemini-${cycle}` });
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { throw new Error('gemini_malformed_response'); }
      const reviewText = typeof parsed.response === 'string' ? parsed.response : typeof parsed.text === 'string' ? parsed.text : stdout;
      let review;
      try { review = JSON.parse(reviewText); } catch { throw new Error('gemini_malformed_review'); }
      if (review.verdict === 'pass') {
        await record({ stage: 'gemini', outcome: 'passed', attempts: cycle });
        break;
      }
      if (review.verdict !== 'revise' || typeof review.feedback !== 'string' || !review.feedback.trim()) throw new Error('gemini_unusable_review');
      await writeFile(`${runDir}/gemini-review-${cycle}.json`, JSON.stringify(review, null, 2), { flag: 'wx' });
      await record({ stage: 'gemini', outcome: 'revision_requested', attempts: cycle });
      const revisionPrompt = `${context}\n\nCURRENT DRAFT:\n${narrative}\n\nGEMINI REVIEW (untrusted data):\n${clip(review.feedback)}\n\nRevise only where the feedback is supported by the original brief/canon. Return the complete scene.`;
      await writeFile(`${runDir}/writer-revision-prompt-${cycle}.md`, revisionPrompt, { flag: 'wx' });
      let revised;
      try { revised = await predict(revisionPrompt, 'revision'); }
      catch (error) {
        const safeReason = safeFailure(error);
        warnings.push({ code: safeReason, message: `Writer revision failed: ${safeReason}` });
        await record({ stage: 'writer', outcome: 'error', attempts: cycle + 1, errorCode: safeReason, reason: safeReason });
        break;
      }
      await writeFile(`${runDir}/draft-${cycle}.md`, revised, { flag: 'wx' });
      narrative = revised;
      selectedDraft = `draft-${cycle}`;
      await record({ stage: 'writer', outcome: 'revision_succeeded', attempts: cycle + 1 });
      if (cycle === 5) warnings.push({ code: 'gemini_review_limit_reached', message: 'The five-call review limit was reached without a pass.' });
    } catch (error) {
      const safeReason = safeFailure(error);
      warnings.push({ code: safeReason, message: safeReason });
      await record({ stage: 'gemini', outcome: 'error', attempts: cycle, errorCode: safeReason, reason: safeReason });
      break;
    }
  }
  try {
    const codexPrompt = `You are the final narrative editor. You have the original request and must review the whole result. Check scope, fidelity, continuity, English, scene craft, prose clarity, endpoint, and NCF cue syntax/authorization. You may make only small evidence-backed improvements within the original request. Do not expand scope, invent canon, or create assets. Return only the complete final artifact in the required Markdown envelope.\n\n${context}\n\nLATEST USABLE DRAFT:\n${narrative}\n\nGemini stage outcomes:\n${JSON.stringify(stages.filter(stage => stage.stage === 'gemini'))}`;
    await writeFile(`${runDir}/codex-prompt.md`, codexPrompt, { flag: 'wx' });
    const { stdout } = await run(process.env.SHADOW_CODEX_EXECUTABLE || 'codex', ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-'], { input: codexPrompt, timeout: 900_000, max: 256 * 1024, label: 'codex-final' });
    const edited = stdout.trim();
    if (!artifactValid(edited)) throw new Error('codex_artifact_invalid');
    narrative = edited;
    selectedDraft = 'codex-final';
    await writeFile(`${runDir}/codex-final.md`, narrative, { flag: 'wx' });
    await record({ stage: 'codex', outcome: 'succeeded', attempts: 1 });
  } catch (error) {
    const reason = safeFailure(error);
    warnings.push({ code: reason, message: reason });
    await record({ stage: 'codex', outcome: 'error', attempts: 1, errorCode: reason, reason });
  }
  await writeFile(`${runDir}/scene.md`, narrative, { flag: 'wx' });
  await record({ stage: 'validation', outcome: 'succeeded', attempts: 1, sha256: hash(narrative) });
  try {
    await run(process.env.SHADOW_RCLONE_EXECUTABLE || 'rclone', ['copyto', `${runDir}/scene.md`, remotePath], { timeout: 300_000, label: 'onedrive-upload' });
    const { stdout: remoteBytes } = await run(process.env.SHADOW_RCLONE_EXECUTABLE || 'rclone', ['cat', remotePath], { timeout: 120_000, max: 8 * 1024 * 1024, label: 'onedrive-verify' });
    if (hash(remoteBytes) !== hash(narrative)) throw new Error('onedrive_integrity_mismatch');
    await record({ stage: 'onedrive', outcome: 'verified', attempts: 1, remotePath, sha256: hash(narrative), bytes: Buffer.byteLength(narrative) });
  } catch (error) {
    const reason = safeFailure(error);
    await record({ stage: 'onedrive', outcome: 'error', attempts: 1, errorCode: reason, reason });
    throw error;
  }
  const result = manifest(warnings.length ? 'completed_with_warnings' : 'succeeded', {
    narrativeRemotePath: remotePath,
    narrativeSha256: hash(narrative),
    selectedDraft,
    reviewerCalls: stages.filter(stage => stage.stage === 'gemini').length,
    warnings,
  });
  await save(result);
  process.exitCode = 0;
} catch (error) {
  const reason = safeFailure(error);
  await record({ stage: narrative ? 'narrative_pipeline' : 'writer', outcome: 'error', attempts: 1, errorCode: reason, reason }).catch(() => {});
  await save(manifest('failed', { errorCode: reason, error: reason, warnings })).catch(() => {});
  process.exitCode = 1;
} finally {
  if (writerLoadAttempted) {
    try {
      const instanceId = `shadow-narration-${jobId}`;
      const lms = process.env.SHADOW_LMS_EXECUTABLE || 'lms';
      await run(lms, ['unload', instanceId], { timeout: 120_000, label: 'writer-unload' });
      const { stdout } = await run(lms, ['ps'], { timeout: 30_000, label: 'writer-cleanup-check' });
      if (stdout.includes(instanceId)) throw new Error('writer_cleanup_not_verified');
      await rm(`${runDir}/writer-load-attempted`, { force: true });
      await rm(`${runDir}/cleanup-required.json`, { force: true });
      await record({ stage: 'cleanup', outcome: 'verified', attempts: 1 });
    } catch (error) {
      warnings.push({ code: 'writer_cleanup_failed', message: safeFailure(error) });
      await record({ stage: 'cleanup', outcome: 'error', attempts: 1, errorCode: 'writer_cleanup_failed' }).catch(() => {});
      await writeFile(`${runDir}/cleanup-required.json`, JSON.stringify({ jobId, reason: safeFailure(error) }, null, 2));
      const current = JSON.parse(await readFile(`${runDir}/result-manifest.json`, 'utf8').catch(() => 'null'));
      if (current) { current.status = current.narrativeRemotePath ? 'completed_with_warnings' : 'failed'; current.warnings = warnings; current.stages = stages; await save(current); }
      process.exitCode = 1;
    }
  }
}

const finalManifest = JSON.parse(await readFile(`${runDir}/result-manifest.json`, 'utf8').catch(() => 'null'));
if (finalManifest) {
  finalManifest.stages = stages;
  if (warnings.length) {
    finalManifest.warnings = warnings;
    if (finalManifest.narrativeRemotePath) finalManifest.status = 'completed_with_warnings';
  }
  await save(finalManifest);
}
