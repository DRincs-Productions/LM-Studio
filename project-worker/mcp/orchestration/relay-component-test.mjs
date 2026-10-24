import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const seed = crypto.randomBytes(8).toString('hex');
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '') + '_' + seed;
const directory = path.join(root, 'production-tests', 'components', runId);
await fs.mkdir(directory, { recursive: true });
const pick = values => values[crypto.randomInt(values.length)];
const name = `Leda-${seed.slice(0, 4)}`;
const premise = `An adult cartographer named ${name} curates ${pick(['a floating archive of forgotten routes', 'a mountain library of unbuilt bridges', 'a traveling museum of unfinished maps'])}. A visitor returns a map bearing a route that nobody remembers drawing. Tone: ${pick(['warm mystery with dry humor', 'hopeful adventure with gentle banter'])}. The visitor's identity and the route's origin remain unresolved. Creative discussion only; no production or implementation is approved.`;
const manifest = { runId, seed, mode: 'component', role: 'regia', entrypoint: 'codex-relay', model: 'qwen/qwen3.5-9b', premise, status: 'started', productionStarted: false, implementationStarted: false };
const manifestPath = path.join(directory, 'manifest.json');
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
let client;
async function connect() {
  client = new Client({ name: 'regia-relay-component-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../server.mjs')], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: directory } }));
}
async function call(name, args) {
  const request = { name, arguments: args };
  let response;
  try { response = await client.callTool(request, undefined, { timeout: 1800000 }); }
  catch (error) { await fs.appendFile(path.join(directory, 'mcp-calls.jsonl'), JSON.stringify({ request, error: error.message }) + '\n'); throw error; }
  await fs.appendFile(path.join(directory, 'mcp-calls.jsonl'), JSON.stringify({ request, response }) + '\n');
  if (response.isError) throw Error(response.content.map(item => item.text || '').join('\n'));
  return response.content.map(item => item.text || '').join('\n');
}
try {
  await connect();
  const created = await call('create_project_file', { project_name: `relay-${runId}`, initial_content: `## Canon\n\n${premise}\n` });
  const filename = created.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  assert.ok(filename); manifest.projectFile = filename;
  await call('read_project_file', { filename });
  const session = JSON.parse(await call('start_regia_session', { filename }));
  manifest.sessionId = session.session_id;
  const messages = [
    `Fammi parlare con la Regia. Vorrei sviluppare questa idea: ${premise} Aiutami a scegliere la direzione del mistero; le spiegazioni non sono ancora decise. Non avviare produzione.`,
    'Coordinatore simulato per il test componente: il brief è ancora aperto. Chiedi all’utente se preferisce che la mappa nasconda un segreto personale oppure una scoperta geografica. Non scegliere al suo posto e non avviare produzione.'
  ];
  for (let index = 0; index < messages.length; index++) {
    const requestId = crypto.randomUUID();
    const args = { filename, session_id: session.session_id, request_id: requestId, message: messages[index] };
    const response = JSON.parse(await call('talk_to_regia', args));
    assert.equal(response.speaker, 'Regia'); assert.ok(response.reply.trim());
    await fs.writeFile(path.join(directory, `response-${index + 1}.json`), JSON.stringify(response, null, 2));
    await fs.writeFile(path.join(directory, `response-${index + 1}.txt`), response.reply);
    // Verify restart recovery and exact cached retrieval without a second prediction.
    if (!index) {
      await client.close(); await connect();
      assert.deepEqual(JSON.parse(await call('talk_to_regia', args)), response);
    }
    if (response.proposed_project_document) {
      await call('update_project_file', { filename, content: response.proposed_project_document, expected_sha256: response.expected_sha256 });
      const readback = await call('read_project_file', { filename });
      assert.ok(readback.includes(response.proposed_project_document));
    }
    await call('record_component_test', { run_id: runId, role: 'regia', model: manifest.model, input: messages[index], response: response.reply, interaction: index ? 'analysis' : 'clarification', mock_reply: index ? 'Component ends; no production.' : messages[1] });
  }
  await call('stop_regia_session', { filename, session_id: session.session_id });
  assert.equal(JSON.parse(await call('get_regia_session', { filename })).active, false);
  const resumed = JSON.parse(await call('start_regia_session', { filename }));
  assert.equal(resumed.session_id, session.session_id); assert.equal(resumed.turns, 2);
  await call('stop_regia_session', { filename, session_id: session.session_id });
  const status = JSON.parse(await call('get_orchestration_status', { filename }));
  assert.equal(status.orchestration.status, 'regia_ready'); assert.equal(status.orchestration.handback, null);
  manifest.status = 'completed_pending_manual_review';
  manifest.verified = ['real MCP', 'real Regia', 'restart and idempotent retrieval', 'suspend/resume same transcript', 'no production job'];
} catch (error) { manifest.status = 'failed'; manifest.error = error.stack; process.exitCode = 1; }
finally { await client?.close(); await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); }
console.log(JSON.stringify({ runId, directory, status: manifest.status, error: manifest.error }, null, 2));
