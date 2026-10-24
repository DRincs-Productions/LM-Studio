import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writerInstruction, LocalChatApi } from './production.mjs';
import { cleanCliText } from './cli-output.mjs';

const root = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.lmstudio');
const projectWorker = path.join(root, 'project-worker', 'mcp', 'server.mjs');
const productionTests = path.join(root, 'production-tests', 'components');
const modelConfigRoot = path.join(root, 'apps', 'bionic', '.internal', 'user-concrete-model-default-config');
const lms = path.join(root, 'bin', 'lms.exe');
const localChat = new LocalChatApi(lms);
const roles = ['regia', 'coordinator', 'writer', 'designer', 'sound_designer'];
const names = {
  regia: 'Regia', coordinator: 'Coordinator', writer: 'Writer', designer: 'Designer', sound_designer: 'Sound Designer'
};
const mockReplies = {
  regia: 'Coordinator (simulated) asks: The brief leaves the final reveal ambiguous. Should the reveal be tender or comic? No production has started.',
  coordinator: 'Writer (simulated) reports one continuity gap and requests a focused revision. Do not start image/audio production.',
  writer: 'Reviewer (simulated) flags one local continuity detail and asks for a targeted correction while preserving the scene and voice.',
  designer: 'Coordinator (simulated) requests clearer character silhouette and visual continuity; keep the scene composition intact.',
  sound_designer: 'Reviewer (simulated) hears a click at the loop seam. Revise the cue prompt while keeping its intended category and mood.'
};
const tasks = {
  regia: 'Discuss the project with the user. Ask one concise creative question that resolves an ambiguity, then summarize the approved facts you would persist. Do not claim a file was saved or begin production.',
  coordinator: 'Analyze the approved brief, produce a short task plan for Writer, Designer and Sound Designer, and identify one genuine question to return to Regia. Do not start workers.',
  writer: 'Write a short original narrative passage from the brief. Preserve canon and voice. Do not mention the test or invent decisions outside the brief.',
  designer: 'Produce a concise image-generation prompt and a short continuity checklist from the brief. Do not generate or publish an image.',
  sound_designer: 'Produce one concise sound cue specification including category, loop behavior, trigger and stop condition. Do not generate or publish audio.'
};

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function runId() { return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${crypto.randomBytes(6).toString('hex')}`; }
function uniqueBrief() {
  const pick = values => values[crypto.randomInt(values.length)];
  const people = [pick(['Neri Vale', 'Mara Quill', 'Ivo Senn', 'Tali Rook']), pick(['a retired lighthouse keeper', 'a night-shift botanist', 'a courier who collects postcards', 'a radio astronomer'])];
  return `Original test premise ${crypto.randomBytes(4).toString('hex')}: ${people[0]}, ${people[1]}, discovers that ${pick(['the town clock is answering questions one minute early', 'an empty greenhouse receives letters from next spring', 'a ferry ticket is stamped with tomorrow’s weather', 'the local radio station is broadcasting a caller who has not phoned yet'])}. Setting: ${pick(['a rain-soaked harbor', 'a rooftop garden above a quiet station', 'a small mountain observatory', 'a night market after closing'])}. Tone: ${pick(['wry and warm', 'gentle mystery with playful banter', 'hopeful and lightly absurd', 'romantic comedy with a small mystery'])}. Keep all named characters adults.`;
}

async function configForRole(role) {
  if (role === 'regia') {
    const p = path.join(modelConfigRoot, 'Qwen', 'qwen3.5-9b.json');
    const json = JSON.parse(await fs.readFile(p, 'utf8'));
    return { engine: 'lms', model: 'qwen/qwen3.5-9b', system: json.operation.fields.find(x => x.key === 'llm.prediction.systemPrompt')?.value || '' };
  }
  if (role === 'writer') {
    const p = path.join(modelConfigRoot, 'JohnDi', 'Hemmingway-1-Abliterated-Extreme-GGUF', 'Hemmingway1-Extreme-Q4_K_M.gguf.json');
    const json = JSON.parse(await fs.readFile(p, 'utf8'));
    return { engine: 'writer-api', config: json, model: 'JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF/Hemmingway1-Extreme-Q4_K_M.gguf', system: json.operation.fields.find(x => x.key === 'llm.prediction.systemPrompt')?.value || '' };
  }
  return { engine: 'codex', model: 'Codex CLI configured default', system: `You are the ${names[role]} in a component test. Complete the requested role task only; do not run production or edit files. Use plain text.` };
}

async function ask(config, prompt, system, cwd, output) {
  await fs.writeFile(output + '.request.json', JSON.stringify({ model: config.model, engine: config.engine, prompt, system, config: config.config }, null, 2) + '\n');
  if (config.engine === 'writer-api') {
    const ps = spawnSync(lms, ['ps', '--json'], { encoding: 'utf8', windowsHide: true });
    if (ps.status !== 0) throw Error(`Cannot inspect Writer model instances: ${ps.stderr}`);
    const matches = JSON.parse(ps.stdout).filter(instance => instance.indexedModelIdentifier === config.model || instance.path === config.model);
    if (matches.length !== 1 || matches[0].status !== 'idle' || matches[0].queued) throw Error('Component Writer requires exactly one idle loaded instance of its configured model');
    const result = await localChat.predict(matches[0].identifier, prompt, system, config.config, 'writer');
    result.modelInstance = matches[0];
    await fs.writeFile(output + '.raw.json', JSON.stringify(result, null, 2) + '\n');
    return result.text;
  }
  if (config.engine === 'lms') {
    const result = spawnSync(lms, ['chat', config.model, '--prompt', prompt, '--system-prompt', system, '--dont-fetch-catalog'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(output + '.raw.json', JSON.stringify({ stdout: result.stdout, stderr: result.stderr, status: result.status, error: result.error?.message }, null, 2));
    if (result.error || result.status !== 0) throw Error(`LM Studio CLI failed (${result.status ?? result.error?.message ?? 'unknown error'}): ${result.stderr || result.stdout}`);
    return cleanCliText(result.stdout);
  }
  const result = spawnSync('codex', ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', output, '--cd', cwd, '-'], { cwd, encoding: 'utf8', input: `${system}\n\n${prompt}`, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`Codex CLI failed (${result.status ?? result.error?.message ?? 'unknown error'})`);
  return fs.readFile(output, 'utf8').then(x => x.trim());
}

const role = arg('--role');
if (!roles.includes(role)) throw Error(`Usage: node component-test.mjs --role ${roles.join('|')}`);
const id = runId();
const runDirectory = path.join(productionTests, id);
await fs.mkdir(runDirectory, { recursive: true });
const brief = uniqueBrief() + (role === 'writer' ? '\n\nApproved scene canon: The protagonist carries a sealed parcel in their left hand. They do not open it or transfer it to the right hand. A brass bell rings exactly once during the discovery. Show the discovery on-page, then end when the protagonist places the still-sealed parcel on a table. No choices, sound/music directions, new named characters, romance escalation, or events after that endpoint are authorized. English narrative and an accurate Italian production summary are required.' : '');
const profile = await configForRole(role);
const manifestPath = path.join(runDirectory, 'manifest.json');
const initialManifest = { runId: id, seed: id, role, model: profile.model, mode: 'component', uniqueInput: brief, status: 'started', productionStarted: false, implementationStarted: false };
await fs.writeFile(manifestPath, JSON.stringify(initialManifest, null, 2) + '\n');
const system = profile.system || `You are ${names[role]}. Follow the role task and project brief. Keep the response useful and concrete.`;
const client = new Client({ name: 'bionic-component-test-runner', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [projectWorker], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: runDirectory } });
const originalCallTool = client.callTool.bind(client);
client.callTool = async request => {
  try {
    const result = await originalCallTool(request);
    await fs.appendFile(path.join(runDirectory, 'mcp-calls.jsonl'), JSON.stringify({ request, result }) + '\n');
    return result;
  } catch (error) {
    await fs.appendFile(path.join(runDirectory, 'mcp-calls.jsonl'), JSON.stringify({ request, error: error.message }) + '\n');
    throw error;
  }
};
await client.connect(transport);
try {
  const created = await client.callTool({ name: 'create_project_file', arguments: { project_name: `component-${role}-${id}`, initial_content: `## Test brief\n\n${brief}\n\n## Test mode\n\nComponent-only. No production assets or implementation are authorized.\n` } });
  const createText = created.content?.map(c => c.text || '').join('\n') || '';
  const filename = createText.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!filename) throw Error(`Project Worker did not create a test project file: ${createText}`);
  const readback = await client.callTool({ name: 'read_project_file', arguments: { filename } });
  if (readback.isError || !readback.content?.some(c => c.text?.includes(brief))) throw Error('Project File read-back did not preserve the test brief');
  const status = await client.callTool({ name: 'get_orchestration_status', arguments: { filename } }).catch(() => null);
  const task = `${role === 'regia' ? 'Conversazione utente in italiano: aiutami a definire questa idea; non autorizzo alcuna produzione. Rispondi in italiano, mantenendo in inglese soltanto il riepilogo destinato al Project File.\n\n' : ''}${tasks[role]}\n\nThe harness has already created and read back the canonical Project File through MCP: ${filename}. Preserve this exact filename. The brief below is its verified content. You have no direct tool access in this CLI conversation; propose documentation updates only, without claiming a write or creating another filename.\n\nProject brief:\n${brief}`;
  const actualTask = role === 'writer' ? writerInstruction(brief, tasks.writer) : task;
  const first = await ask(profile, actualTask, system, runDirectory, path.join(runDirectory, 'model-output-1.txt'));
  await fs.writeFile(path.join(runDirectory, 'model-output-1.txt'), first + '\n');
  const mockReply = role === 'writer' ? 'Reviewer (simulated): Controlled local revision request. Add the exact sentence "The parcel stayed sealed." immediately before the final narrative paragraph to make the approved seal continuity explicit. Keep all other narrative paragraphs verbatim, preserve the endpoint, and update only the Italian summary if necessary. This is a test edit request, not a claim that a real reviewer found a defect.' : mockReplies[role];
  const firstEvent = role === 'regia' ? 'clarification' : role === 'coordinator' ? 'handoff' : 'revision';
  const record1 = await client.callTool({ name: 'record_component_test', arguments: { run_id: id, role, input: actualTask, model: profile.model, response: first, interaction: firstEvent, mock_reply: mockReply } });
  if (record1.isError) throw Error(record1.content?.map(c => c.text || '').join('\n') || 'MCP failed to record first interaction');
  const secondPrompt = `Original task and canon:\n${task}\n\nYour previous response:\n${first}\n\nContinue your role after receiving this controlled test response from the next participant:\n${mockReply}\n\nRevise or respond while preserving the approved facts. Do not start real production or implementation.`;
  const actualSecondPrompt = role === 'writer' ? writerInstruction(brief, tasks.writer, first, mockReply) : secondPrompt;
  const second = await ask(profile, actualSecondPrompt, system, runDirectory, path.join(runDirectory, 'model-output-2.txt'));
  await fs.writeFile(path.join(runDirectory, 'model-output-2.txt'), second + '\n');
  const record2 = await client.callTool({ name: 'record_component_test', arguments: { run_id: id, role, input: actualSecondPrompt, model: profile.model, response: second, interaction: role === 'regia' ? 'analysis' : 'revision', mock_reply: 'Recorded. This component test ends without starting production.' } });
  if (record2.isError) throw Error(record2.content?.map(c => c.text || '').join('\n') || 'MCP failed to record second interaction');
  const result = {
    runId: id, seed: id, role, model: profile.model, mode: 'component', status: 'completed_pending_review', createdAt: new Date().toISOString(),
    uniqueInput: brief, modelPrompts: [actualTask, actualSecondPrompt], controlledReply: mockReply, projectFile: filename, projectFilePath: path.join(runDirectory, filename),
    interactions: [firstEvent, 'simulated_reply', 'revision'],
    outputs: [path.join(runDirectory, 'model-output-1.txt'), path.join(runDirectory, 'model-output-2.txt')],
    mcpRecording: record1.content?.map(c => c.text || '').join('\n'),
    secondMcpRecording: record2.content?.map(c => c.text || '').join('\n'),
    productionStarted: false, implementationStarted: false,
    orchestrationStatus: status?.content?.map(c => c.text || '').join('\n') || 'not requested'
  };
  await fs.writeFile(path.join(runDirectory, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
  await fs.writeFile(path.join(runDirectory, 'input.md'), `# Component Test: ${names[role]}\n\n${brief}\n\n## First response\n\n${first}\n\n## Controlled reply\n\n${mockReply}\n\n## Revised response\n\n${second}\n`);
  console.log(JSON.stringify({ runId: id, role, projectFile: filename, outputDirectory: runDirectory, status: 'completed' }, null, 2));
} catch (error) {
  await fs.writeFile(manifestPath, JSON.stringify({ ...initialManifest, status: 'failed', error: error.stack }, null, 2) + '\n');
  throw error;
} finally { await client.close(); await localChat.stopIfOwned(); }

