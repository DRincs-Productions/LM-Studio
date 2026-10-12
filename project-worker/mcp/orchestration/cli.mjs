import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from './core.mjs';
import { discoverBinding, MemoryManager, verifyBinding, run } from './bionic.mjs';

const [action = 'status', filename, idleSeconds = '0'] = process.argv.slice(2);
if (!['status', 'suspend', 'resume'].includes(action) || !filename) throw Error('Usage: node cli.mjs status|suspend|resume <Project File basename> [idle seconds]');
const ttl = Number(idleSeconds);
if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86400) throw Error('Invalid idle timeout');
const store = new Store();
let state = await store.register(filename);
if (!state.binding) {
  const binding = await discoverBinding(state.bindingToken, null, { legacyFilename: filename });
  state = await store.update(filename, s => { s.binding = binding; });
}
const binding = await verifyBinding(state.binding, state.bindingToken);
const memory = new MemoryManager();
const key = binding.modelSpecifier.indexedModelIdentifier;
if (action === 'status') {
  console.log(JSON.stringify({ projectId: state.projectId, projectFile: filename, bionicProjectId: binding.bionicProjectId, regiaSessionId: binding.regiaSessionId, owner: state.owner, status: state.status, model: key, loadedInstances: (await memory.list()).filter(m => m.indexedModelIdentifier === key), handback: state.handback }, null, 2));
} else if (action === 'suspend') {
  if (state.status === 'running' || state.status === 'queued') throw Error('Coordinator manages memory during a job; refusing a second memory controller');
  console.log(JSON.stringify(await memory.suspend(binding)));
} else {
  if (state.owner === 'codex') throw Error('Codex currently owns production; refusing to reload Regia into its VRAM');
  if ((await memory.list()).some(m => m.indexedModelIdentifier === key)) console.log('Regia model already loaded');
  else {
    const args = ['load', key, '--yes']; if (ttl) args.push('--ttl', String(ttl));
    const result = await run(memory.lms, args, { timeoutMs: 180000 });
    if (result.code !== 0) throw Error('Regia model preload failed');
    console.log('Regia model preloaded. Continue the original Bionic session; no message was injected.');
  }
}
