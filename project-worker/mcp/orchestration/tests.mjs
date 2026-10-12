import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, sha, waitHandback } from './core.mjs';
import { discoverBinding, MemoryManager } from './bionic.mjs';
import { runJob } from './runner.mjs';

const handback = { summary: 'Prototype complete. Alex remains blonde and wears a black leather jacket.', completedTasks: ['Created prototype'], assets: [], problems: [], decisions: ['Choose a mission'], questionForUser: 'Which mission should Alex take?' };
async function fixture(t) {
  await fs.mkdir(path.resolve('work'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('work', 'bionic unit fixture '));
  const store = new Store(root);
  await fs.writeFile(store.project('project.md'), '# Canonical project\nAlex is blonde.\n');
  const state = await store.register('project.md');
  await store.update('project.md', s => { s.binding = { regiaSessionId: 'fixture-session', modelSpecifier: { type: 'indexed', indexedModelIdentifier: 'fixture-model' } }; });
  return { root, store, state: await store.read('project.md') };
}
async function enqueue(f) {
  const state = await f.store.read('project.md');
  return f.store.enqueue('project.md', { phase: 'prototype', summary: 'Create a prototype', expectedRevision: state.revision, expectedSha256: sha(await fs.readFile(f.store.project('project.md'), 'utf8')) });
}

test('two full persistent handoff/handback cycles and idempotent registration', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.register('project.md')).projectId, f.state.projectId);
  for (let i = 0; i < 2; i++) {
    const queued = await enqueue(f);
    const waiting = waitHandback(f.store, 'project.md', queued.job.id, { timeoutMs: 5000 });
    await runJob(f.store, 'project.md', { suspendRegia: true }, { verifyBinding: async b => b, memory: { suspend: async () => ({ status: 'unloaded' }) }, execute: async () => handback });
    assert.equal((await waiting).handback.summary, handback.summary);
    const state = await f.store.read('project.md'); assert.equal(state.owner, 'regia');
    await f.store.acknowledge('project.md', queued.job.id);
    await f.store.acknowledge('project.md', queued.job.id);
  }
  assert.equal((await f.store.read('project.md')).history.length, 2);
});
test('stale revision, hash conflict, duplicate start and path traversal are refused', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.project('../outside.md'));
  await assert.rejects(f.store.enqueue('project.md', { phase: 'x', summary: 'x', expectedRevision: -1, expectedSha256: 'wrong' }), /Stale/);
  await assert.rejects(f.store.enqueue('project.md', { phase: 'x', summary: 'x', expectedRevision: f.state.revision, expectedSha256: 'wrong' }), /changed/);
  await enqueue(f); await assert.rejects(enqueue(f), /not owned/);
});
test('cancelled MCP wait leaves job intact and later wait gets handback', async t => {
  const f = await fixture(t), state = await enqueue(f), controller = new AbortController(); controller.abort();
  assert.equal((await waitHandback(f.store, 'project.md', state.job.id, { signal: controller.signal })).status, 'wait_cancelled');
  assert.equal((await f.store.read('project.md')).status, 'queued');
  await f.store.finish('project.md', state.job.id, handback);
  assert.equal((await waitHandback(f.store, 'project.md', state.job.id)).status, 'handback_ready');
});
test('unavailable PC 2/dependency returns an error handback and never retries effects', async t => {
  const f = await fixture(t); await enqueue(f); let attempts = 0;
  const adapters = { verifyBinding: async b => b, execute: async () => { attempts++; throw Error('PC 2 unavailable'); } };
  await runJob(f.store, 'project.md', { suspendRegia: false }, adapters);
  await runJob(f.store, 'project.md', { suspendRegia: false }, adapters);
  const state = await f.store.read('project.md'); assert.equal(state.handback.status, 'error'); assert.equal(attempts, 1);
});
test('project updates are atomic, backed up and reject conflicting writes', async t => {
  const f = await fixture(t), old = await fs.readFile(f.store.project('project.md'), 'utf8');
  await f.store.replaceProject('project.md', '# Updated\nAlex remains blonde.\n', sha(old));
  await assert.rejects(f.store.replaceProject('project.md', 'Wrong', sha(old)), /Concurrent/);
  const files = await fs.readdir(path.join(f.store.stateRoot, 'project-backups')); assert.equal(files.length, 1);
});
test('memory manager refuses busy, queued, ambiguous or changing instances; unloads only selected idle model', async () => {
  const binding = { modelSpecifier: { indexedModelIdentifier: 'regia' } };
  const base = { indexedModelIdentifier: 'regia', identifier: 'instance-regia', status: 'idle', queued: 0 };
  for (const models of [[{ ...base, status: 'busy' }], [{ ...base, queued: 1 }], [base, base]]) {
    const m = new MemoryManager('fake', async () => ({ code: 0, stdout: JSON.stringify(models) }));
    await assert.rejects(m.suspend(binding));
  }
  const calls = []; let loaded = true;
  const m = new MemoryManager('fake', async (_, args) => { calls.push(args); if (args[0] === 'unload') loaded = false; return { code: 0, stdout: JSON.stringify(loaded ? [base, { ...base, indexedModelIdentifier: 'writer', identifier: 'writer' }] : []) }; });
  assert.equal((await m.suspend(binding)).status, 'unloaded');
  assert.deepEqual(calls.find(c => c[0] === 'unload'), ['unload', 'instance-regia']);
});
test('automatic association uses exact native tool result marker and fails on forks', async t => {
  const f = await fixture(t), dbPath = path.join(f.root, 'fixture.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, committed_head_entry_id TEXT, session_json TEXT); CREATE TABLE chat_entries (id TEXT, previous_id TEXT, entry_json TEXT, redirect_to_id TEXT);');
  db.prepare('INSERT INTO chat_entries VALUES (?, ?, ?, NULL)').run('request', null, JSON.stringify({ message: { role: 'assistant', parts: [{ type: 'toolCallRequest', name: 'register_project', uniqueToolCallId: 'call' }] } }));
  db.prepare('INSERT INTO chat_entries VALUES (?, ?, ?, NULL)').run('result', 'request', JSON.stringify({ message: { role: 'tool', parts: [{ type: 'toolCallResult', uniqueToolCallId: 'call', result: [{ type: 'text', text: 'BIONIC_BINDING_TOKEN: ' + f.state.bindingToken }] }] } }));
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('session-one', 'result', JSON.stringify({ modelSpecifier: { type: 'indexed', indexedModelIdentifier: 'regia' } }));
  const locations = [{ database: dbPath, bionicProjectId: 'project-one' }];
  const before = await fs.readFile(dbPath);
  assert.equal((await discoverBinding(f.state.bindingToken, locations)).regiaSessionId, 'session-one');
  assert.deepEqual(await fs.readFile(dbPath), before);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('session-fork', 'result', JSON.stringify({ modelSpecifier: { type: 'indexed', indexedModelIdentifier: 'regia' } }));
  await assert.rejects(discoverBinding(f.state.bindingToken, locations), /Ambiguous/); db.close();
});
test('dead runners return an interrupted handback without replaying production', async t => {
  const f = await fixture(t), queued = await enqueue(f);
  await f.store.update('project.md', s => { s.status = 'running'; s.job.runnerPid = 99999999; s.job.codexPid = 99999998; });
  const result = await waitHandback(f.store, 'project.md', queued.job.id, { timeoutMs: 2000 });
  assert.equal(result.handback.status, 'interrupted'); assert.equal((await f.store.read('project.md')).owner, 'regia');
});
