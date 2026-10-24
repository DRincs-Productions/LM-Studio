import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sha } from './core.mjs';

const userRoot = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Shadow';
const defaultRoots = [path.join(userRoot, '.lmstudio', 'production-tests'), 'C:\\AI\\projects'];
const id = () => crypto.randomUUID();
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function inside(candidate, root) {
  const item = path.resolve(candidate).toLowerCase();
  const base = path.resolve(root).toLowerCase();
  return item === base || item.startsWith(base + path.sep.toLowerCase());
}

async function allowedProjectRoot(projectRoot) {
  const roots = process.env.BIONIC_PROGRAMMER_ROOTS
    ? process.env.BIONIC_PROGRAMMER_ROOTS.split(path.delimiter).filter(Boolean)
    : defaultRoots;
  const real = await fs.realpath(path.resolve(projectRoot));
  const approved = [];
  for (const candidate of roots) {
    try { approved.push(await fs.realpath(path.resolve(candidate))); } catch {}
  }
  if (!approved.some(root => inside(real, root))) throw Error('Project directory is outside configured Programmer roots');
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw Error('Project root must be a directory');
  return real;
}

function commandAvailable(command) {
  const result = spawnSync('where.exe', [command], { windowsHide: true, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().split(/\r?\n/)[0];
}

async function readSelection(store, filename) {
  const file = path.join(store.stateRoot, 'programmer', `${sha(filename.toLowerCase())}.json`);
  return { file, value: JSON.parse(await fs.readFile(file, 'utf8')) };
}
async function writeJson(file, value) {
  const temporary = `${file}.${id()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temporary, file);
}

export async function selectProgrammer({ store, filename, provider, projectRoot }) {
  if (!['claude', 'codex'].includes(provider)) throw Error('Choose either Claude or Codex');
  await fs.access(store.project(filename));
  const root = await allowedProjectRoot(projectRoot);
  const state = await store.read(filename);
  if (state.status !== 'regia_ready') throw Error('A completed and acknowledged creative/production handback is required before implementation');
  const executable = commandAvailable(provider === 'claude' ? 'claude' : 'codex');
  if (!executable) throw Error(`${provider} CLI is unavailable. No automatic provider fallback is allowed.`);
  return store.locked(`programmer-gate-${sha(filename.toLowerCase())}.md`, async () => {
    const directory = path.join(store.stateRoot, 'programmer');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${sha(filename.toLowerCase())}.json`);
    const previous = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.status === 'running') throw Error('A Programmer run is already active');
    const selection = {
      selectionId: id(), projectFile: filename, projectId: state.projectId, provider,
      executable, projectRoot: root, projectFileSha256: sha(await fs.readFile(store.project(filename))),
      status: 'awaiting_explicit_approval', selectedAt: new Date().toISOString()
    };
    await writeJson(file, selection);
    return text({ status: selection.status, selection_id: selection.selectionId, provider, project_root: root, next: 'Ask the user in a separate turn for explicit approval before calling start_programmer.' });
  });
}

export async function startProgrammer({ store, filename, selectionId, approvalText, implementationBrief }) {
  const prepared = await store.locked(`programmer-gate-${sha(filename.toLowerCase())}.md`, async () => {
    const { file, value: selection } = await readSelection(store, filename);
    if (selection.selectionId !== selectionId) throw Error('Programmer selection is stale or does not match this project');
    if (selection.status !== 'awaiting_explicit_approval') throw Error('Programmer selection was already used or is not awaiting approval');
    if (!approvalText.trim()) throw Error('Separate explicit user approval is required');
    const canonical = await fs.readFile(store.project(filename), 'utf8');
    if (sha(canonical) !== selection.projectFileSha256) throw Error('Project File changed after provider selection; reread it and select the Programmer again');
    const root = await allowedProjectRoot(selection.projectRoot);
    if (root !== selection.projectRoot) throw Error('Project directory identity changed after provider selection');
    selection.status = 'running';
    selection.runId = id();
    selection.approvalText = approvalText;
    selection.implementationBriefSha256 = sha(implementationBrief);
    selection.startedAt = new Date().toISOString();
    await writeJson(file, selection);
    return { file, selection, canonical, root };
  });
  const { file, selection, canonical, root } = prepared;
  const runId = selection.runId;
  const runDirectory = path.join(store.stateRoot, 'runs', runId, 'programmer');
  await fs.mkdir(runDirectory, { recursive: true });
  const answerPath = path.join(runDirectory, 'last-message.txt');
  const prompt = `Implement the approved work in this project directory only: ${root}\n\nCanonical Project File (${filename}):\n${canonical}\n\nImplementation brief:\n${implementationBrief}\n\nThe user selected ${selection.provider} and separately approved starting this implementation: ${approvalText}\n\nUse your configured default model. Preserve approved story facts and assets. Inspect the project first, make the implementation in this directory, run relevant project checks, and report the files changed and their verification. Do not modify Bionic, MCP configuration, model settings, credentials, or files outside the project directory.`;
  let args;
  if (selection.provider === 'codex') {
    args = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', '--color', 'never', '--output-last-message', answerPath, '--cd', root, '-'];
  } else {
    args = ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text'];
  }
  const timeoutMs = Number(process.env.BIONIC_PROGRAMMER_TIMEOUT_MS) || 4 * 60 * 60 * 1000;
  const result = await new Promise(resolve => {
    const child = spawn(selection.executable, args, { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish({ code: -1, timedOut: true }); }, timeoutMs);
    child.once('error', () => finish({ code: -1, unavailable: true }));
    child.once('spawn', () => child.stdin.end(prompt));
    child.once('close', code => finish({ code: code ?? -1 }));
  });
  const response = await fs.readFile(answerPath, 'utf8').catch(() => '');
  selection.status = result.code === 0 && response.trim() ? 'completed' : 'error';
  selection.finishedAt = new Date().toISOString();
  selection.exitCode = result.code;
  selection.timedOut = !!result.timedOut;
  selection.resultPath = answerPath;
  selection.error = result.timedOut ? 'Programmer deadline exceeded' : result.unavailable ? `${selection.provider} process could not be started` : result.code !== 0 ? `${selection.provider} exited with code ${result.code}` : response.trim() ? null : 'Provider returned no saved final response';
  await store.locked(`programmer-gate-${sha(filename.toLowerCase())}.md`, async () => writeJson(file, selection));
  return text({ status: selection.status, provider: selection.provider, project_root: root, run_id: runId, result_path: answerPath, summary: response.slice(0, 12000), error: selection.error });
}

export async function recordComponentTest({ store, run_id, role, input, model, response, interaction, mock_reply }) {
  const folder = path.join(store.stateRoot, 'component-tests');
  await fs.mkdir(folder, { recursive: true });
  const recordPath = path.join(folder, `${run_id}.json`);
  const inputHash = sha(input);
  const indexPath = path.join(folder, 'input-hashes.json');
  return store.locked('component-test-input-index.md', async () => {
    const index = await fs.readFile(indexPath, 'utf8').then(JSON.parse).catch(() => []);
    if (index.some(entry => entry.sha256 === inputHash)) throw Error('This test input was used before; generate a different premise and input');
    const entries = await fs.readFile(recordPath, 'utf8').then(JSON.parse).catch(() => []);
    if (entries.some(entry => entry.role !== role)) throw Error('One component-test run cannot mix roles');
    const entry = { turn: entries.length + 1, runId: run_id, role, input, inputSha256: inputHash, model, response, interaction, mockReply: mock_reply, createdAt: new Date().toISOString() };
    entries.push(entry);
    await fs.writeFile(recordPath, JSON.stringify(entries, null, 2) + '\n');
    index.push({ runId: run_id, role, sha256: inputHash, createdAt: entry.createdAt });
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
    return text({ status: 'component_test_recorded', run_id, role, input_sha256: inputHash, interaction, simulated_reply: mock_reply, production_started: false, asset_generation_started: false, implementation_started: false, record_path: recordPath });
  });
}
