import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, sha, waitHandback, alive } from './core.mjs';
import { discoverBinding } from './bionic.mjs';
import { configuration } from './runner.mjs';
import { produceScene, finalizeReviewedScene } from './production.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const store = new Store();
export const textResult = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
export function registrationText(state) { return `PROJECT_ID: ${state.projectId}\nBIONIC_BINDING_TOKEN: ${state.bindingToken}\nPROJECT_FILE: ${state.projectFile}\nUse get_orchestration_status after this result is recorded to establish the automatic session association.`; }

async function tryBind(filename) {
  const state = await store.read(filename);
  if (state.binding) return state;
  const binding = await discoverBinding(state.bindingToken, null, { legacyFilename: filename });
  return store.update(filename, s => { s.binding = binding; });
}

export async function projectContext(filename) {
  let state;
  try { state = await store.read(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { sha256: sha(await fs.readFile(store.project(filename), 'utf8')), orchestration: state ? { projectId: state.projectId, owner: state.owner, status: state.status, phase: state.phase, revision: state.revision, bindingVerified: !!state.binding, jobId: state.job?.id, handback: state.handback } : null };
}

async function launchJob(filename, jobId) {
  const state = await store.read(filename);
  if (state.status !== 'queued' || state.job.id !== jobId) throw Error('Job is not queued');
  if (state.job.launcherPid && alive(state.job.launcherPid)) throw Error('Queued job already has a live launcher');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(here, 'runner.mjs'), filename], { detached: true, stdio: 'ignore', shell: false, windowsHide: true, env: process.env });
      child.once('error', reject);
      child.once('spawn', async () => {
        child.unref();
        try { await store.update(filename, s => { if (s.job.id === jobId) s.job.launcherPid = child.pid; }); resolve(); }
        catch (e) { reject(e); }
      });
    });
  } catch {
    const current = await store.read(filename);
    if (current.status === 'queued') await store.finish(filename, jobId, { summary: 'The coordinator could not be started.', completedTasks: [], assets: [], problems: ['Runner launch failed'], decisions: ['Inspect the coordinator installation before retrying.'], questionForUser: 'Should this phase be retried after the runner is repaired?' }, 'error');
    else throw Error('Runner started but launch bookkeeping failed; retrieve its persistent status');
  }
}

export function installTools(server) {
  const tool = (name, description, schema, fn) => server.tool(name, description, schema, async (params, extra) => {
    try { return textResult(await fn(params, extra)); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
  tool('produce_scene_assets', 'Codex Coordinator only: run the approved Writer → Narrative Reviewer content-only loop (maximum three cycles). Formatting defects do not block Reviewer PASS and are returned for Codex repair. Returns the draft, presentation checks, review and source SHA256. Does not generate images. Call finalize_reviewed_scene once after a bounded Codex review and final edit.', { filename: z.string() }, async ({ filename }) => produceScene(filename));
  tool('finalize_reviewed_scene', 'Codex Coordinator only: submit review and final narrative against the exact Reviewer-approved source SHA256. Codex may fix formatting and make at most 55 changed narrative-word edits and 16% change; larger content repairs must return to Writer/Regia, never trigger a scene rewrite. The worker validates content, presentation, evidence, edit budget and hashes, writes the final artifact, then proceeds to image generation/review, publication and hash-verified asset transfer. Refuses stale drafts or replay.', {
    filename: z.string(), source_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    review_summary: z.string().min(20).max(4000), changes_made: z.string().min(8).max(4000),
    final_check: z.string().min(20).max(4000), final_narrative: z.string().min(1).max(30000)
  }, async ({ filename, source_sha256, review_summary, changes_made, final_check, final_narrative }) => finalizeReviewedScene(filename, {
    sourceSha256: source_sha256, reviewSummary: review_summary, changesMade: changes_made, finalCheck: final_check, finalNarrative: final_narrative
  }));
  tool('register_project', 'Associate an existing canonical Project File with this Regia session automatically. No session UUID needed. Call once from Regia, then get_orchestration_status.', { filename: z.string() }, async ({ filename }) => registrationText(await store.register(filename)));
  tool('get_orchestration_status', 'Read project ownership, pending handback, Project File hash and revision. Establish the session binding after register_project. Use before production handoff and at the start of a resumed Regia turn.', { filename: z.string() }, async ({ filename }) => {
    let note = null;
    try { await tryBind(filename); } catch (e) { note = e.message; }
    return { ...await projectContext(filename), bindingNote: note };
  });
  tool('handoff_to_codex', 'After saving creative decisions in the English Project File, delegate one production phase to Codex and WAIT. The model is unloaded only after it is idle. This native tool result returns the persisted handback to this same chat. Do not run the production pipeline yourself. If cancelled, work persists; later use wait_for_handback. Requires a verified session binding.', {
    filename: z.string(), production_approved: z.boolean(), approval_text: z.string().min(1).max(4000), phase: z.string().min(1).max(200), summary: z.string().min(1).max(12000), expected_revision: z.number().int(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }, async ({ filename, production_approved, approval_text, phase, summary, expected_revision, expected_sha256 }, extra) => {
    if (!production_approved) throw Error('Explicit user approval is required before production');
    const config = await configuration();
    if (!config.coordinatorEnabled) throw Error('Coordinator disabled');
    await tryBind(filename);
    const state = await store.enqueue(filename, { phase, summary, expectedRevision: expected_revision, expectedSha256: expected_sha256 });
    await store.update(filename, s => { s.job.approval = { text: approval_text, recordedAt: new Date().toISOString() }; });
    await launchJob(filename, state.job.id);
    return waitHandback(store, filename, state.job.id, { signal: extra.signal, timeoutMs: config.waitTimeoutMs });
  });
  tool('wait_for_handback', 'Wait for the already running Codex job and return its structured handback in this session. Does not start a new job. Bionic reloads Regia when the native tool result is available.', { filename: z.string() }, async ({ filename }, extra) => {
    const state = await store.read(filename);
    if (!state.job) throw Error('No job exists');
    return waitHandback(store, filename, state.job.id, { signal: extra.signal, timeoutMs: (await configuration()).waitTimeoutMs });
  });
  tool('acknowledge_handback', 'Regia only: acknowledge a retrieved handback after reading the canonical Project File and incorporate its facts into the creative conversation. Required before the next handoff cycle.', { filename: z.string(), job_id: z.string().uuid() }, async ({ filename, job_id }) => {
    const state = await store.acknowledge(filename, job_id); return { status: state.status, revision: state.revision };
  });
  tool('recover_interrupted_job', 'Recover a dead coordinator as an interrupted handback. Never automatically repeats work; inspect produced files before deciding on a new handoff.', { filename: z.string() }, async ({ filename }) => {
    const state = await store.recover(filename); return state.handback;
  });
  tool('resume_queued_job', 'Start an existing queued job only if its launcher is no longer alive. Used after an MCP/service interruption before execution began. Never replays a running or completed production job.', { filename: z.string() }, async ({ filename }, extra) => {
    const state = await store.read(filename); if (!state.job) throw Error('No job exists');
    await launchJob(filename, state.job.id);
    return waitHandback(store, filename, state.job.id, { signal: extra.signal, timeoutMs: (await configuration()).waitTimeoutMs });
  });
}
