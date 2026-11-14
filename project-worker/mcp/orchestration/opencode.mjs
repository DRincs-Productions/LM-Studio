import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const DEFAULT_OPENCODE_MODEL = 'openai/gpt-6-luna';

export function openCodeExecutable() {
  if (process.env.OPENCODE_EXECUTABLE) return process.env.OPENCODE_EXECUTABLE;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  return 'opencode';
}

export function extractOpenCodeText(output) {
  const text = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') text.push(event.part.text);
    } catch { /* Ignore non-JSON diagnostic lines. */ }
  }
  return text.join('').trim();
}

function commandFor(executable, args) {
  if (/\.m?js$/i.test(executable)) return { command: process.execPath, args: [executable, ...args] };
  return { command: executable, args };
}

export async function runOpenCode({
  cwd,
  workspace = cwd,
  prompt,
  requestPath = path.join(cwd, 'opencode-request.md'),
  responsePath,
  model = process.env.SHADOW_OPENCODE_MODEL || process.env.BIONIC_OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL,
  agent,
  files = [],
  timeoutMs = 15 * 60 * 1000,
  maxOutputBytes = 16 * 1024 * 1024,
  auto = false,
  config,
  configPath = path.join(cwd, 'opencode.json'),
  env = {},
  label = 'opencode',
  onSpawn,
} = {}) {
  if (!cwd || typeof prompt !== 'string' || !prompt.trim()) throw Error('OpenCode request is incomplete');
  await fs.writeFile(requestPath, prompt, { flag: 'wx' });
  if (config) {
    const serializedConfig = JSON.stringify(config, null, 2) + '\n';
    try { await fs.writeFile(configPath, serializedConfig, { flag: 'wx' }); }
    catch (error) {
      if (error?.code !== 'EEXIST' || await fs.readFile(configPath, 'utf8').catch(() => '') !== serializedConfig) throw error;
    }
    env = { ...env, OPENCODE_CONFIG: configPath };
  }

  const executable = openCodeExecutable();
  const args = ['--standalone', 'run', '--model', model, '--format', 'json'];
  if (agent) args.push('--agent', agent);
  if (auto) args.push('--auto');
  for (const file of files) args.push('--file', file);
  args.push('--file', requestPath, 'Follow the attached request and return only its requested result.');
  const { command, args: commandArgs } = commandFor(executable, args);
  const stdoutPath = path.join(cwd, `${label}.stdout.txt`);
  const stderrPath = path.join(cwd, `${label}.stderr.txt`);

  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: workspace, env: { ...process.env, ...env }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false, timedOut = false, overflow = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > maxOutputBytes) { overflow = true; child.kill(); return current; }
      return next;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    }, timeoutMs);
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    child.once('spawn', () => { try { onSpawn?.(child.pid); } catch {} });
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => finish(reject, error));
    child.once('close', async code => {
      try {
        await fs.writeFile(stdoutPath, stdout, { flag: 'wx' });
        await fs.writeFile(stderrPath, stderr, { flag: 'wx' });
      } catch (error) { finish(reject, error); return; }
      if (timedOut) { finish(reject, Error('OpenCode request timed out; request and logs were preserved')); return; }
      if (overflow) { finish(reject, Error('OpenCode output exceeded its capture limit; request and logs were preserved')); return; }
      if (code !== 0) { finish(reject, Error(`OpenCode exited with code ${code}; request and logs were preserved`)); return; }
      const text = extractOpenCodeText(stdout);
      if (!text) { finish(reject, Error('OpenCode returned no text result; request and logs were preserved')); return; }
      if (responsePath) await fs.writeFile(responsePath, text, { flag: 'wx' });
      finish(resolve, { text, stdout, stderr, model, exitCode: code, stdoutPath, stderrPath });
    });
  });
  return result;
}
