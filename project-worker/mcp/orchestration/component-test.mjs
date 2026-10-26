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
const writerProfiles = {
  hemmingway: {
    config: path.join(modelConfigRoot, 'JohnDi', 'Hemmingway-1-Abliterated-Extreme-GGUF', 'Hemmingway1-Extreme-Q4_K_M.gguf.json'),
    model: 'JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF/Hemmingway1-Extreme-Q4_K_M.gguf'
  },
  paintedfantasy: {
    config: path.join(modelConfigRoot, 'mradermacher', 'MS3.2-PaintedFantasy-v4.1-24B-GGUF', 'MS3.2-PaintedFantasy-v4.1-24B.Q4_K_M.gguf.json'),
    model: 'mradermacher/MS3.2-PaintedFantasy-v4.1-24B-GGUF/MS3.2-PaintedFantasy-v4.1-24B.Q4_K_M.gguf'
  },
  cydonia: {
    config: path.join(modelConfigRoot, 'mradermacher', 'Cydonia-24B-v4.3-GGUF', 'Cydonia-24B-v4.3.Q4_K_M.gguf.json'),
    model: 'mradermacher/Cydonia-24B-v4.3-GGUF/Cydonia-24B-v4.3.Q4_K_M.gguf'
  },
  zwielicht: {
    config: path.join(modelConfigRoot, 'mradermacher', 'Zwielicht-27B-GGUF', 'Zwielicht-27B.Q4_K_M.gguf.json'),
    model: 'mradermacher/Zwielicht-27B-GGUF/Zwielicht-27B.Q4_K_M.gguf'
  },
  qwenwriter27b: {
    config: path.join(modelConfigRoot, 'llmfan46', 'Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF', 'Qwen3.5-27B-Writer-V2-uncensored-heretic-Q4_K_S.gguf.json'),
    model: 'llmfan46/Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF/Qwen3.5-27B-Writer-V2-uncensored-heretic-Q4_K_S.gguf'
  }
};
const writerCases = ['normal', 'hot', 'violent'];
const roles = ['regia', 'coordinator', 'writer', 'designer'];
const names = {
  regia: 'Regia', coordinator: 'Coordinator', writer: 'Writer', designer: 'Designer'
};
const mockReplies = {
  regia: 'Coordinator (simulated) asks: The brief leaves the final reveal ambiguous. Should the reveal be tender or comic? No production has started.',
  coordinator: 'Writer (simulated) reports one continuity gap and requests a focused revision. Do not start image/audio production.',
  writer: 'Reviewer (simulated) flags one local continuity detail and asks for a targeted correction while preserving the scene and voice.',
  designer: 'Coordinator (simulated) requests clearer character silhouette and visual continuity; keep the scene composition intact.',
};
const tasks = {
  regia: 'Discuss the project with the user. Ask one concise creative question that resolves an ambiguity, then summarize the approved facts you would persist. Do not claim a file was saved or begin production.',
  coordinator: 'Analyze the approved brief, produce a short task plan for Writer, Designer and Sound Designer, and identify one genuine question to return to Regia. Do not start workers.',
  writer: 'Write the requested original narrative scene. Prioritize the case-specific content, canon, tone, continuity, and endpoint. Do not add unrelated events or mention the test.',
  designer: 'Produce a concise image-generation prompt and a short continuity checklist from the brief. Do not generate or publish an image.',
};

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function runId() { return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${crypto.randomBytes(6).toString('hex')}`; }
function recordableInput(value, fullPromptPath) {
  const marker = `\n[Prompt truncated for MCP size limit; complete prompt saved at ${fullPromptPath}]`;
  return value.length <= 12000 ? value : `${value.slice(0, 12000 - marker.length)}${marker}`;
}
function uniqueBrief() {
  const pick = values => values[crypto.randomInt(values.length)];
  const people = [pick(['Neri Vale', 'Mara Quill', 'Ivo Senn', 'Tali Rook']), pick(['a retired lighthouse keeper', 'a night-shift botanist', 'a courier who collects postcards', 'a radio astronomer'])];
  return `Original test premise ${crypto.randomBytes(4).toString('hex')}: ${people[0]}, ${people[1]}, discovers that ${pick(['the town clock is answering questions one minute early', 'an empty greenhouse receives letters from next spring', 'a ferry ticket is stamped with tomorrow’s weather', 'the local radio station is broadcasting a caller who has not phoned yet'])}. Setting: ${pick(['a rain-soaked harbor', 'a rooftop garden above a quiet station', 'a small mountain observatory', 'a night market after closing'])}. Tone: ${pick(['wry and warm', 'gentle mystery with playful banter', 'hopeful and lightly absurd', 'romantic comedy with a small mystery'])}. Keep all named characters adults.`;
}

function writerCaseBrief(testCase) {
  const nonce = crypto.randomBytes(4).toString('hex');
  const protagonist = ['Mara Venn', 'Neri Vale', 'Ivo Senn', 'Tali Rook'][crypto.randomInt(4)];
  const partner = ['Lena Ors', 'Aki Tanaka', 'Sera Dain', 'Oren Pike'][crypto.randomInt(4)];
  if (testCase === 'normal') return `Fresh ordinary-narrative case ${nonce}. ${protagonist}, age 32, is closing a small neighborhood repair shop during a rainstorm when ${partner}, age 35, arrives to collect a repaired hand-cranked radio. Keep the scene grounded and non-romantic, with no sexual content or graphic violence. Canon: the radio has one loose brass dial; ${protagonist} carries its small repair key in the left hand until placing it on the counter at the end. The scene must show the handoff and end immediately when the repaired radio begins receiving a familiar station.`;
  if (testCase === 'hot') return `Fresh hot-narrative case ${nonce}. ${protagonist}, age 32, and ${partner}, age 35, are fictional adults who have been in an established relationship for two years. In their private rented cabin after a difficult journey, write a heated, explicitly consensual erotic scene with clear mutual desire and sensual physical intimacy. Both are sober and freely choose to continue; no coercion, age ambiguity, or other characters. Canon: ${protagonist} wears a silver ring on the right hand and removes it before intimate contact; the scene ends as the couple pause together after intimacy, without introducing future plans.`;
  if (testCase === 'violent') return `Fresh gruesome-narrative case ${nonce}. ${protagonist}, age 32, is an adult emergency medic in a fictional flood-damaged town when ${partner}, age 35, is found trapped beneath a collapsed market awning with a severe bleeding leg wound. Write a tense, graphic fictional injury-and-rescue scene; do not romanticize the violence or introduce sexual violence. Canon: ${protagonist} uses a red field bandage from the open medical kit, keeps the injured adult conscious by speaking to them, and ends the scene when rescue workers take over. Do not add another named character or a second injury.`;
  throw Error(`Unknown writer case: ${testCase}`);
}

async function configForRole(role, writerProfileId = 'hemmingway') {
  if (role === 'regia') {
    const p = path.join(modelConfigRoot, 'Qwen', 'qwen3.5-9b.json');
    const json = JSON.parse(await fs.readFile(p, 'utf8'));
    return { engine: 'lms', model: 'qwen/qwen3.5-9b', system: json.operation.fields.find(x => x.key === 'llm.prediction.systemPrompt')?.value || '' };
  }
  if (role === 'writer') {
    const selected = writerProfiles[writerProfileId];
    if (!selected) throw Error(`Unknown Writer profile: ${writerProfileId}. Choose ${Object.keys(writerProfiles).join('|')}`);
    const json = JSON.parse(await fs.readFile(selected.config, 'utf8'));
    return { engine: 'writer-api', config: json, model: selected.model, profileId: writerProfileId, system: json.operation.fields.find(x => x.key === 'llm.prediction.systemPrompt')?.value || '' };
  }
  return { engine: 'codex', model: 'Codex CLI configured default', system: `You are the ${names[role]} in a component test. Complete the requested role task only; do not run production or edit files. Use plain text.` };
}

async function ask(config, prompt, system, cwd, output) {
  await fs.writeFile(output + '.request.json', JSON.stringify({ model: config.model, engine: config.engine, prompt, system, config: config.config }, null, 2) + '\n');
  if (config.engine === 'writer-api') {
    await localChat.ensure();
    const response = await fetch('http://127.0.0.1:1234/api/v1/models', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`Cannot inspect Writer model instances: LM Studio API returned HTTP ${response.status}`);
    const inventory = await response.json();
    const loadedModels = (inventory.models || []).filter(model => model.type === 'llm' && model.loaded_instances?.length);
    const expectedKey = path.basename(path.dirname(config.model)).replace(/-gguf$/i, '').toLowerCase();
    const matchingModels = loadedModels.filter(model => model.key === expectedKey);
    if (loadedModels.length !== 1 || matchingModels.length !== 1 || matchingModels[0].loaded_instances.length !== 1) throw Error(`Component Writer requires exactly one loaded instance of ${expectedKey}; found ${loadedModels.map(model => `${model.key} (${model.loaded_instances?.length || 0})`).join(', ') || 'none'}`);
    const instance = matchingModels[0].loaded_instances[0];
    const result = await localChat.predict(instance.id, prompt, system, config.config, 'writer');
    result.modelInstance = { ...instance, modelKey: matchingModels[0].key, displayName: matchingModels[0].display_name, quantization: matchingModels[0].quantization, sizeBytes: matchingModels[0].size_bytes, contextLength: instance.config?.context_length };
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
const regiaCase = arg('--regia-case');
if (regiaCase && role !== 'regia') throw Error('--regia-case can only be used with --role regia');
if (role === 'regia' && regiaCase) {
  if (!['empty', 'modify', 'resume'].includes(regiaCase)) throw Error('--regia-case must be empty, modify, or resume');
  const result = spawnSync(process.execPath, [path.join(root, 'project-worker', 'mcp', 'orchestration', 'regia-component-test.mjs'), '--case', regiaCase], {
    cwd: path.join(root, 'project-worker', 'mcp'), stdio: 'inherit', windowsHide: true
  });
  if (result.error || result.status !== 0) throw Error(`Regia ${regiaCase} component test failed (${result.status ?? result.error?.message ?? 'unknown error'})`);
  process.exit(0);
}
if (role === 'sound_designer') throw Error('Run `node project-worker/mcp/orchestration/audio-component-test.mjs` instead. Codex coordinates the Audio Worker test and does not act as the Sound Designer.');
if (!roles.includes(role)) throw Error(`Usage: node component-test.mjs --role ${roles.join('|')}`);
const writerProfileId = role === 'writer' ? (arg('--writer-profile') || 'hemmingway') : null;
const writerCase = role === 'writer' ? (arg('--writer-case') || 'normal') : null;
const writerBriefFile = role === 'writer' ? arg('--writer-brief-file') : null;
const comparisonSeed = role === 'writer' ? arg('--comparison-seed') : null;
if (role === 'writer' && !writerCases.includes(writerCase)) throw Error(`Writer case must be one of: ${writerCases.join('|')}`);
if (comparisonSeed && !/^[a-f0-9]{16}$/.test(comparisonSeed)) throw Error('--comparison-seed must be 16 lowercase hexadecimal characters');
if (role !== 'writer' && (arg('--writer-profile') || arg('--writer-case') || arg('--writer-brief-file') || arg('--comparison-seed'))) throw Error('Writer profile, case, brief, and comparison seed flags can only be used with --role writer');
const id = runId();
const runDirectory = path.join(productionTests, id);
await fs.mkdir(runDirectory, { recursive: true });
const brief = role === 'writer'
  ? (writerBriefFile ? (await fs.readFile(path.resolve(writerBriefFile), 'utf8')).trim() : writerCaseBrief(writerCase))
  : uniqueBrief();
const profile = await configForRole(role, writerProfileId || 'hemmingway');
const manifestPath = path.join(runDirectory, 'manifest.json');
const initialManifest = { runId: id, seed: id, ...(comparisonSeed ? { comparisonSeed } : {}), role, ...(role === 'writer' ? { writerProfile: writerProfileId, writerCase, ...(writerBriefFile ? { writerBriefFile: path.resolve(writerBriefFile) } : {}) } : {}), model: profile.model, predictionSettings: profile.config?.operation?.fields?.filter(field => field.key !== 'llm.prediction.systemPrompt') || [], loadSettings: profile.config?.load?.fields || [], mode: 'component', uniqueInput: brief, status: 'started', productionStarted: false, implementationStarted: false };
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
  const predictionTimings = [];
  const timedAsk = async (label, prompt, output) => {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const response = await ask(profile, prompt, system, runDirectory, output);
    predictionTimings.push({ label, startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) });
    return response;
  };
  const first = await timedAsk('draft', actualTask, path.join(runDirectory, 'model-output-1.txt'));
  await fs.writeFile(path.join(runDirectory, 'model-output-1.txt'), first + '\n');
  const mockReply = role === 'writer'
    ? ({
        normal: 'Reviewer (simulated): Add one sentence before the final paragraph explicitly confirming that the repaired radio has one loose brass dial. Preserve the left-hand key continuity and exact endpoint; leave all unaffected prose unchanged. This is a controlled test edit, not a claim that a real reviewer found a defect.',
        hot: 'Reviewer (simulated): Add one brief, direct line of dialogue immediately before intimate contact that confirms both adults want to continue. Preserve the consensual erotic tone and all other prose verbatim. This is a controlled test edit, not a claim that a real reviewer found a defect.',
        violent: 'Reviewer (simulated): Add one sentence before rescue workers take over confirming that the injured adult remains conscious while the medic applies the red field bandage. Preserve the requested graphic injury scene and all other prose verbatim. This is a controlled test edit, not a claim that a real reviewer found a defect.'
      })[writerCase]
    : mockReplies[role];
  const firstEvent = role === 'regia' ? 'clarification' : role === 'coordinator' ? 'handoff' : 'revision';
  const record1 = await client.callTool({ name: 'record_component_test', arguments: { run_id: id, role, input: recordableInput(actualTask, path.join(runDirectory, 'model-output-1.txt.request.json')), model: profile.model, response: first, interaction: firstEvent, mock_reply: mockReply } });
  if (record1.isError) throw Error(record1.content?.map(c => c.text || '').join('\n') || 'MCP failed to record first interaction');
  const secondPrompt = `Original task and canon:\n${task}\n\nYour previous response:\n${first}\n\nContinue your role after receiving this controlled test response from the next participant:\n${mockReply}\n\nRevise or respond while preserving the approved facts. Do not start real production or implementation.`;
  const actualSecondPrompt = role === 'writer' ? writerInstruction(brief, tasks.writer, first, mockReply) : secondPrompt;
  const second = await timedAsk('simulated-revision', actualSecondPrompt, path.join(runDirectory, 'model-output-2.txt'));
  await fs.writeFile(path.join(runDirectory, 'model-output-2.txt'), second + '\n');
  const record2 = await client.callTool({ name: 'record_component_test', arguments: { run_id: id, role, input: recordableInput(actualSecondPrompt, path.join(runDirectory, 'model-output-2.txt.request.json')), model: profile.model, response: second, interaction: role === 'regia' ? 'analysis' : 'revision', mock_reply: 'Recorded. This component test ends without starting production.' } });
  if (record2.isError) throw Error(record2.content?.map(c => c.text || '').join('\n') || 'MCP failed to record second interaction');
  const result = {
    runId: id, seed: id, ...(comparisonSeed ? { comparisonSeed } : {}), role, ...(role === 'writer' ? { writerProfile: writerProfileId, writerCase, ...(writerBriefFile ? { writerBriefFile: path.resolve(writerBriefFile) } : {}), predictionTimings, totalPredictionMs: predictionTimings.reduce((sum, item) => sum + item.elapsedMs, 0) } : {}), model: profile.model, predictionSettings: profile.config?.operation?.fields?.filter(field => field.key !== 'llm.prediction.systemPrompt') || [], loadSettings: profile.config?.load?.fields || [], mode: 'component', status: 'completed_pending_review', createdAt: new Date().toISOString(),
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

