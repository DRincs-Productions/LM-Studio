import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { sleep } from './core.mjs';

export function run(exe, args, { cwd, stdin, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: killed }); });
  });
}

export async function databaseLocations(lmRoot = process.env.BIONIC_LM_ROOT || path.join(process.env.USERPROFILE, '.lmstudio')) {
  const app = path.join(lmRoot, 'apps', 'bionic');
  const data = JSON.parse(await fs.readFile(path.join(app, '.internal', 'projects-registry.json'), 'utf8'));
  return (data.json?.projects || []).map(([id, config]) => ({ bionicProjectId: id, database: path.join(config.path, '.internal', 'ng-sessions.sqlite') }));
}

// Read-only matching of an exact random marker in a native MCP tool result.
// Session titles, most-recent timestamps and arbitrary transcript text are not identity proofs.
export async function discoverBinding(token, locations = null, { legacyFilename = null } = {}) {
  const matches = [];
  const marker = 'BIONIC_BINDING_TOKEN: ' + token;
  for (const loc of locations || await databaseLocations()) {
    try { await fs.access(loc.database); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let db;
    try {
      db = new DatabaseSync(loc.database, { readOnly: true });
      db.exec('BEGIN');
      const sessions = db.prepare('SELECT session_id, committed_head_entry_id, session_json FROM sessions').all();
      const lookup = db.prepare('SELECT id, previous_id, entry_json, redirect_to_id FROM chat_entries WHERE id = ?');
      for (const session of sessions) {
        let id = session.committed_head_entry_id, seen = new Set(), found = null;
        for (let n = 0; id && n < 30000; n++) {
          if (seen.has(id)) throw Error('Cycle in session chain'); seen.add(id);
          const row = lookup.get(id); if (!row) break;
          if (row.redirect_to_id) { id = row.redirect_to_id; continue; }
          const entry = JSON.parse(row.entry_json);
          for (const part of entry.message?.parts || []) {
            if (entry.message.role === 'tool' && part.type === 'toolCallResult' && Array.isArray(part.result)) {
              const exact = part.result.some(p => p.type === 'text' && p.text?.split(/\r?\n/).includes(marker));
              const legacy = !exact && legacyFilename && part.result.some(p => p.type === 'text' && p.text?.split(/\r?\n/).includes('PROJECT_FILE_CREATED') && p.text?.split(/\r?\n/).includes('PROJECT_FILE: ' + legacyFilename));
              if (exact || legacy) found = { resultId: row.id, callId: part.uniqueToolCallId, legacy: !!legacy };
            }
            if (found && part.type === 'toolCallRequest' && part.uniqueToolCallId === found.callId && ['register_project', 'create_project_file'].includes(part.name)) {
              const config = JSON.parse(session.session_json);
              if (found.legacy && part.name !== 'create_project_file') continue;
              matches.push({ ...loc, regiaSessionId: session.session_id, modelSpecifier: config.modelSpecifier, proofEntryId: found.resultId, proofCallId: found.callId, legacyFilename: found.legacy ? legacyFilename : null });
              id = null; break;
            }
          }
          if (id === null) break;
          id = row.previous_id;
        }
      }
      db.exec('ROLLBACK');
    } catch (e) {
      throw Error('Bionic session association could not be verified: ' + e.message);
    } finally { db?.close(); }
  }
  const unique = [...new Map(matches.map(m => [m.bionicProjectId + ':' + m.regiaSessionId, m])).values()];
  if (unique.length !== 1) throw Error(unique.length ? 'Ambiguous binding: marker exists in multiple session chains' : 'Binding marker not yet committed by Bionic');
  if (unique[0].modelSpecifier?.type !== 'indexed') throw Error('This VRAM workflow requires a local indexed Regia model');
  return unique[0];
}

export async function verifyBinding(binding, token) {
  const found = await discoverBinding(token, null, { legacyFilename: binding.legacyFilename });
  if (found.regiaSessionId !== binding.regiaSessionId || found.bionicProjectId !== binding.bionicProjectId) throw Error('Session binding changed');
  return found;
}

export class MemoryManager {
  constructor(lms = path.join(process.env.USERPROFILE, '.lmstudio', 'bin', 'lms.exe'), runner = run) { this.lms = lms; this.runner = runner; }
  async list() {
    const result = await this.runner(this.lms, ['ps', '--json']);
    if (result.code !== 0) throw Error('Cannot inspect loaded models');
    return JSON.parse(result.stdout);
  }
  async suspend(binding) {
    const key = binding.modelSpecifier.indexedModelIdentifier;
    const instances = (await this.list()).filter(m => m.indexedModelIdentifier === key);
    if (!instances.length) return { status: 'already_unloaded', model: key };
    if (instances.length !== 1) throw Error('Multiple Regia model instances: refusing automatic unload');
    const selected = instances[0];
    if (selected.status !== 'idle' || selected.queued !== 0) throw Error('Regia model is busy; handoff postponed');
    await sleep(500);
    const second = (await this.list()).find(m => m.identifier === selected.identifier);
    if (!second || second.status !== 'idle' || second.queued !== 0) throw Error('Model state changed; refusing unload');
    const result = await this.runner(this.lms, ['unload', selected.identifier]);
    if (result.code !== 0) throw Error('Model unload failed');
    if ((await this.list()).some(m => m.identifier === selected.identifier)) throw Error('Model still loaded or automatically reloaded');
    return { status: 'unloaded', model: key, identifier: selected.identifier, selectedVariant: selected.selectedVariant };
  }
}
