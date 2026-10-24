import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function alive(pid, recordedStartedAt) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); } catch (e) { return e.code === 'EPERM' && !recordedStartedAt; }
  if (recordedStartedAt && process.platform === 'win32') {
    // Windows can reuse a PID after restart. A live PID is the same process only
    // when its OS creation time is no later than the timestamp recorded at spawn.
    // If the OS query fails, keep the conservative "alive" result and do not
    // recover/remove a lock based on an unverified identity.
    const script = `$p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if($p){[Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('o',[Globalization.CultureInfo]::InvariantCulture))}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    if (result.error || result.status !== 0) return true;
    const created = Date.parse((result.stdout || '').trim());
    const expected = Date.parse(recordedStartedAt);
    if (!Number.isFinite(created) || !Number.isFinite(expected)) return true;
    return created <= expected + 1000;
  }
  return true;
}

export class Store {
  constructor(root = process.env.BIONIC_PROJECTS_DIR || 'C:\\AI\\bionic\\projects') {
    this.root = path.resolve(root);
    this.stateRoot = path.join(this.root, '.orchestration');
  }
  project(filename) {
    if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(filename) || filename.includes('..')) throw Error('Invalid project filename');
    return path.join(this.root, filename);
  }
  statePath(filename) { this.project(filename); return path.join(this.stateRoot, sha(filename.toLowerCase()) + '.json'); }
  async ensure() { await fs.mkdir(this.stateRoot, { recursive: true }); }
  async read(filename) { return JSON.parse(await fs.readFile(this.statePath(filename), 'utf8')); }
  async atomic(target, value) {
    const temp = target + '.' + crypto.randomUUID() + '.tmp';
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temp, target); } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
  }
  async locked(filename, fn) {
    await this.ensure();
    const lock = this.statePath(filename) + '.lock';
    for (let tries = 0; ; tries++) {
      try { await fs.mkdir(lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner;
        try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); } catch {}
        // Unknown or live owners are never removed automatically.
        if (owner && !alive(owner.pid, owner.createdAt)) {
          try { await fs.rename(lock, lock + '.abandoned.' + crypto.randomUUID()); } catch {}
        }
        if (tries > 100) throw Error('Project lock busy; inspect lock owner before recovery');
        await sleep(50);
      }
    }
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: now() }));
    try { return await fn(); }
    finally { await fs.unlink(path.join(lock, 'owner.json')); await fs.rmdir(lock); }
  }
  async save(state) {
    state.revision++;
    state.updatedAt = now();
    await this.atomic(this.statePath(state.projectFile), JSON.stringify(state, null, 2) + '\n');
    return state;
  }
  async register(filename) {
    await fs.access(this.project(filename));
    return this.locked(filename, async () => {
      try { return await this.read(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return this.save({ schemaVersion: 1, projectId: crypto.randomUUID(), projectFile: filename,
        bindingToken: crypto.randomUUID(), binding: null, owner: 'regia', phase: 'creative_definition',
        status: 'regia_ready', revision: 0, createdAt: now(), job: null, handback: null, history: [] });
    });
  }
  async update(filename, fn) {
    return this.locked(filename, async () => { const state = await this.read(filename); await fn(state); return this.save(state); });
  }
  async enqueue(filename, { phase, summary, expectedRevision, expectedSha256, executionMode = 'production' }) {
    return this.locked(filename, async () => {
      const state = await this.read(filename);
      if (state.status !== 'regia_ready') throw Error('Project is not owned by Regia or previous handback has not been acknowledged');
      if (state.revision !== expectedRevision) throw Error('Stale project revision');
      if (!['production', 'complete_test'].includes(executionMode)) throw Error('Invalid execution mode');
      if (!state.binding && executionMode !== 'complete_test') throw Error('Session association not verified. Use register_project first and retry after its result has been recorded by Bionic');
      const content = await fs.readFile(this.project(filename), 'utf8');
      if (sha(content) !== expectedSha256) throw Error('Project File changed since last read');
      state.owner = 'codex'; state.phase = phase; state.status = 'queued'; state.handback = null;
      state.job = { id: crypto.randomUUID(), phase, summary, projectSha256: sha(content), executionMode, createdAt: now(), status: 'queued', runnerPid: null };
      return this.save(state);
    });
  }
  async finish(filename, jobId, handback, status = 'completed') {
    validateHandback(handback);
    return this.update(filename, state => {
      if (state.job?.id !== jobId || !['running', 'queued'].includes(state.status)) throw Error('Stale or duplicate job completion');
      state.job.status = status; state.job.finishedAt = now(); state.job.runnerPid = null;
      state.status = 'handback_ready'; state.owner = 'regia';
      state.handback = { ...handback, jobId, status, createdAt: now(), acknowledgedAt: null };
    });
  }
  async acknowledge(filename, jobId) {
    return this.update(filename, state => {
      if (state.handback?.jobId !== jobId) throw Error('Wrong handback job');
      if (state.status === 'regia_ready' && state.handback.acknowledgedAt) return;
      if (state.status !== 'handback_ready') throw Error('No handback to acknowledge');
      state.handback.acknowledgedAt = now(); state.status = 'regia_ready';
      state.history.push({ job: state.job, handback: state.handback });
      state.history = state.history.slice(-32);
    });
  }
  async recover(filename) {
    return this.update(filename, state => {
      if (state.status !== 'running' || alive(state.job.runnerPid, state.job.startedAt) || (state.job.codexPid && alive(state.job.codexPid, state.job.codexStartedAt))) throw Error('Only a job with a dead runner and dead coordinator can be recovered');
      state.owner = 'regia'; state.status = 'handback_ready'; state.job.status = 'interrupted';
      state.handback = { summary: 'The coordinator process stopped. Inspect produced files and job state before retrying.', completedTasks: [], assets: [], problems: ['Interrupted job; side effects may have occurred. No automatic replay.'], decisions: ['Decide whether to retry after inspecting outputs.'], questionForUser: 'May this interrupted phase be retried?', jobId: state.job.id, status: 'interrupted', createdAt: now(), acknowledgedAt: null };
    });
  }
  async replaceProject(filename, content, expectedSha256) {
    return this.locked(filename, async () => {
      const target = this.project(filename);
      const old = await fs.readFile(target, 'utf8');
      if (expectedSha256 && sha(old) !== expectedSha256) throw Error('Concurrent Project File update');
      const backups = path.join(this.stateRoot, 'project-backups'); await fs.mkdir(backups, { recursive: true });
      await fs.writeFile(path.join(backups, sha(filename) + '-' + crypto.randomUUID() + '.md'), old, { flag: 'wx' });
      await this.atomic(target, content);
      return { bytes: Buffer.byteLength(content), sha256: sha(content) };
    });
  }
}

export function validateHandback(value) {
  if (!value || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 12000 || typeof value.questionForUser !== 'string') throw Error('Invalid handback');
  for (const key of ['completedTasks', 'assets', 'problems', 'decisions']) {
    if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(x => typeof x !== 'string' || x.length > 4000)) throw Error('Invalid handback ' + key);
  }
}

export async function waitHandback(store, filename, jobId, { signal, timeoutMs = 300000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (signal?.aborted) return { status: 'wait_cancelled', jobId, note: 'The persistent job continues. Retrieve with wait_for_handback or read_project_file.' };
    const state = await store.read(filename);
    if (state.job?.id !== jobId) throw Error('Project job changed during wait');
    if (state.status === 'handback_ready' || state.handback?.acknowledgedAt) return { status: 'handback_ready', projectId: state.projectId, projectFile: filename, handback: state.handback };
    if (state.status === 'running' && state.job.runnerPid && !alive(state.job.runnerPid, state.job.startedAt) && (!state.job.codexPid || !alive(state.job.codexPid, state.job.codexStartedAt))) {
      await store.recover(filename);
      continue;
    }
    await sleep(300);
  }
  return { status: 'pending', jobId, note: 'Work continues persistently. Use wait_for_handback. Do not start a second job.' };
}
