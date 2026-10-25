import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.lmstudio');
const runSeed = crypto.randomBytes(8).toString('hex');
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${runSeed}`;
const runDirectory = path.join(root, 'production-tests', 'components', runId);
const projectWorker = path.join(root, 'project-worker', 'mcp', 'server.mjs');
const audioWorker = path.join(root, 'audio', 'mcp', 'server.mjs');
const codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.codex');
const codexConfigPath = path.join(codexHome, 'config.toml');
const codexConfig = await fs.readFile(codexConfigPath, 'utf8');
const coordinatorModel = codexConfig.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
if (!coordinatorModel) throw Error(`Could not resolve Codex coordinator model from ${codexConfigPath}`);

await fs.mkdir(runDirectory, { recursive: true });
const pick = values => values[crypto.randomInt(values.length)];
const protagonist = pick(['Mara Quill', 'Neri Vale', 'Ivo Senn', 'Leda Voss', 'Oren Pike', 'Tavi Rook']);
const fixture = pick([
  {
    premise: `${protagonist}, an adult night courier, discovers that a closed ferry terminal printer has produced a blank ticket stamped with tomorrow's weather. The ticket lever clicks once as it releases. Setting: a foggy ferry terminal. Tone: quiet wonder.`,
    cue: { scene_id: 'ferry_ticket_discovery', cue_id: 'ticket_lever_click', description: 'One short mechanical click as an old ticket lever releases a blank ferry ticket.', prompt: 'Create one clean, short mechanical lever click from an old ferry ticket printer releasing a blank ticket. Dry, precise attack with a faint metallic body and quick decay. Quiet terminal ambience, no voices, music, repeated clicks, or extra impacts.' }
  },
  {
    premise: `${protagonist}, an adult greenhouse botanist, finds a seed pod containing a tiny folded map. The brittle pod shell opens with a single soft pop. Setting: an empty rooftop greenhouse at dusk. Tone: curious and gentle.`,
    cue: { scene_id: 'greenhouse_seed_discovery', cue_id: 'seed_pod_pop', description: 'One small brittle seed pod opens with a single soft pop.', prompt: 'Create one brief, natural dry pop as a small brittle seed pod opens, with a tiny papery crackle and a short soft decay. Intimate greenhouse tone, no voices, music, repeated pops, or other impacts.' }
  },
  {
    premise: `${protagonist}, an adult stage technician, discovers a handwritten direction behind a planetarium star chart. A single wooden drawer latch releases. Setting: an empty planetarium after closing. Tone: playful mystery.`,
    cue: { scene_id: 'planetarium_chart_discovery', cue_id: 'wooden_drawer_latch', description: 'One wooden drawer latch releases as the hidden direction is found.', prompt: 'Create one short, dry wooden latch click as a small drawer opens, with a quiet low wooden knock and a brief natural decay. Empty indoor planetarium tone, no voices, music, repeated clicks, or extra impacts.' }
  }
]);
const premise = `Fresh audio component test ${runSeed}: ${fixture.premise}`;
const cue = {
  ...fixture.cue,
  category: 'sound_effect', loop: false,
  loop_reason: 'This is a single discovery accent and should end after its natural decay.',
  trigger: 'Play once at the specified moment of discovery.',
  stop_condition: 'Stop after the sound naturally decays to silence.',
  duration_seconds: 4, model: 'stable_audio_small_sfx'
};
const approval = 'The user explicitly authorized the Sound Designer component test to generate, review, finalize, and publish one passing test asset. Use the unique test run ID as project ID and remote namespace.';
const manifestPath = path.join(runDirectory, 'manifest.json');
const manifest = {
  runId, inputSeed: runSeed, role: 'sound_designer', componentUnderTest: 'Stable Audio 3 Small SFX Q8',
  coordinator: 'Codex', coordinatorModel, mode: 'component', status: 'started', premise,
  cue, testAuthorization: approval, productionStarted: false, testAssetGenerationStarted: false,
  finalizationStarted: false, publicationStarted: false, implementationStarted: false,
  commands: ['node project-worker/mcp/orchestration/audio-component-test.mjs'],
  outputs: [],
  mcpCalls: { projectWorker: 'mcp-calls.jsonl', audioWorker: 'audio-mcp-calls.jsonl' }
};
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const projectClient = new Client({ name: 'codex-audio-component-coordinator', version: '1.0.0' });
const projectTransport = new StdioClientTransport({ command: process.execPath, args: [projectWorker], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: runDirectory } });
const audioClient = new Client({ name: 'codex-audio-component-coordinator', version: '1.0.0' });
const audioTransport = new StdioClientTransport({ command: process.execPath, args: [audioWorker], stderr: 'pipe' });

async function call(client, logName, name, args, timeoutMs = 120000) {
  const request = { name, arguments: args };
  const logPath = path.join(runDirectory, logName);
  try {
    const response = await client.callTool(request, undefined, { timeout: timeoutMs });
    await fs.appendFile(logPath, JSON.stringify({ request, response }) + '\n');
    if (response.isError) throw Error(response.content?.map(item => item.text || '').join('\n') || `${name} returned an MCP error.`);
    return response.content?.map(item => item.text || '').join('\n') || '';
  } catch (error) {
    await fs.appendFile(logPath, JSON.stringify({ request, error: error.message }) + '\n');
    throw error;
  }
}

let audioProgress = { status: 'preflight' };
try {
  await projectClient.connect(projectTransport);
  await audioClient.connect(audioTransport);

  const initialContent = `# Component Test Project\n\n## Fresh Test Premise\n\n${premise}\n\n## Audio Production Brief\n\n- Cue ID: ${cue.cue_id}\n- Category: sound_effect\n- Description: ${cue.description}\n- Prompt: ${cue.prompt}\n- Loop: false\n- Loop reason: ${cue.loop_reason}\n- Trigger: ${cue.trigger}\n- Stop condition: ${cue.stop_condition}\n- Duration: ${cue.duration_seconds} seconds\n- Generator: Stable Audio 3 Small SFX Q8\n\n## Test Scope\n\nCodex acts only as Coordinator. The cue above is a fresh test fixture, not a Sound Designer model response. Generate, review, finalize and publish one passing test asset under this run ID. Do not run game implementation.\n`;
  const projectCreate = await call(projectClient, 'mcp-calls.jsonl', 'create_project_file', { project_name: `audio-component-${runId}`, initial_content: initialContent });
  const projectFile = projectCreate.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!projectFile) throw Error(`Project Worker did not return the test Project File name: ${projectCreate}`);
  manifest.projectFile = projectFile;
  manifest.projectFilePath = path.join(runDirectory, projectFile);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const projectRead = await call(projectClient, 'mcp-calls.jsonl', 'read_project_file', { filename: projectFile });
  if (!projectRead.includes(premise) || !projectRead.includes(cue.prompt)) throw Error('Project Worker read-back did not preserve the fresh test premise and cue.');
  manifest.projectFileVerified = true;
  manifest.orchestrationStatus = await call(projectClient, 'mcp-calls.jsonl', 'get_orchestration_status', { filename: projectFile });
  const recorded = await call(projectClient, 'mcp-calls.jsonl', 'record_component_test', {
    run_id: runId, role: 'sound_designer', input: `${premise}\n\n${JSON.stringify(cue)}`,
    model: 'Stable Audio 3 Small SFX Q8', response: 'The fresh test cue fixture is ready for Audio Worker generation.',
    interaction: 'handoff', mock_reply: 'Reviewer (simulated) acknowledges receipt; actual sound assessment will use the generated WAV, Qwen listening evidence and Coordinator review.'
  });
  if (!recorded.includes('component_test_recorded')) throw Error('Project Worker did not record the component interaction.');

  const systemStatus = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'system_status', {}));
  await fs.writeFile(path.join(runDirectory, 'audio-worker-system-status.json'), JSON.stringify(systemStatus, null, 2) + '\n');
  if (!systemStatus.models?.stable_audio_small_sfx_q8 || !systemStatus.models?.audio_cpp_cli || !systemStatus.audio_perception?.installed || !systemStatus.remote?.configured) throw Error('Audio Worker generator, local listener, or publishing remote is unavailable.');
  const existing = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'find_project_audio_assets', { project_id: runId, category: cue.category }));
  if (existing.candidates?.length) throw Error('Unexpected prior assets exist under the unique test project ID.');

  const audioSeed = crypto.randomInt(0, 2147483647);
  manifest.models = { coordinator: coordinatorModel, generator: 'Stable Audio 3 Small SFX Q8', localListener: 'Qwen2.5 Omni 7B Q4_K_M' };
  manifest.audioSeed = audioSeed;
  manifest.status = 'audio_generation_started';
  manifest.testAssetGenerationStarted = true;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const generated = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'generate_audio', { project_id: runId, ...cue, seed: audioSeed }, 3600000));
  if (generated.status !== 'candidate_generated' || !generated.audio_path || !generated.manifest_path) throw Error('Audio Worker did not produce a WAV candidate and manifest.');
  audioProgress = { status: 'candidate_generated', generated };
  const candidateCopy = path.join(runDirectory, 'candidate.wav');
  const candidateManifestCopy = path.join(runDirectory, 'candidate.wav.json');
  await fs.copyFile(generated.audio_path, candidateCopy);
  await fs.copyFile(generated.manifest_path, candidateManifestCopy);
  manifest.candidatePath = generated.audio_path;
  manifest.candidateCopy = candidateCopy;
  manifest.candidateManifestCopy = candidateManifestCopy;
  manifest.status = 'candidate_generated';
  manifest.outputs.push(candidateCopy, candidateManifestCopy);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const inspection = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'inspect_audio', { audio_path: generated.audio_path }));
  manifest.technicalInspection = inspection;
  if (inspection.duration_seconds !== cue.duration_seconds || inspection.format !== 'WAV' || inspection.finite_samples !== true || inspection.clipped_sample_fraction !== 0) throw Error('Generated WAV failed its technical acceptance checks.');
  const perception = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'review_audio', {
    audio_path: generated.audio_path, category: cue.category, description: cue.description,
    prompt: cue.prompt, loop: false, loop_preview: false,
    trigger: cue.trigger, stop_condition: cue.stop_condition
  }, 900000));
  if (perception.status !== 'perception_report_ready' || perception.report?.status !== 'analyzed') throw Error('Qwen did not return an interpretable listening report.');
  const evidenceCopy = path.join(runDirectory, 'perception-evidence.json');
  await fs.copyFile(perception.evidence_path, evidenceCopy);
  manifest.perception = perception.report;
  manifest.perceptionEvidencePath = perception.evidence_path;
  manifest.perceptionEvidenceCopy = evidenceCopy;
  manifest.outputs.push(evidenceCopy);
  audioProgress = { status: 'candidate_reviewed_by_qwen', generated, inspection, perception };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const reviewInput = {
    task: 'As Coordinator, assess whether this exact generated WAV meets the supplied cue and technical requirements. Use the Qwen listening report as listening evidence; do not claim direct audio listening. Return JSON only: integer score 0-100, boolean major_error, string summary. Score >=80 and no major error are required to finalize.',
    cue, technical_inspection: inspection, qwen_listening_report: perception.report,
    sha256_match: perception.audio_sha256 === inspection.sha256,
    rules: { qwen_analyzed: perception.report.status === 'analyzed', qwen_aligned: perception.report.brief_alignment === 'aligned', no_major_audio_issues: !perception.report.issues.some(issue => issue.severity === 'major'), minimum_confidence: 25 }
  };
  await fs.writeFile(path.join(runDirectory, 'coordinator-review.request.json'), JSON.stringify(reviewInput, null, 2) + '\n');
  const reviewPath = path.join(runDirectory, 'coordinator-review.json');
  const reviewRun = spawnSync('codex', ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', reviewPath, '--cd', runDirectory, '-'], {
    cwd: runDirectory, encoding: 'utf8', input: `${JSON.stringify(reviewInput, null, 2)}\n\nFollow the requested JSON schema exactly.`, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024
  });
  if (reviewRun.error || reviewRun.status !== 0) throw Error(`Codex Coordinator assessment failed (${reviewRun.status ?? reviewRun.error?.message ?? 'unknown error'}): ${reviewRun.stderr || reviewRun.stdout}`);
  const reviewText = await fs.readFile(reviewPath, 'utf8');
  const reviewMatch = reviewText.match(/\{[\s\S]*\}/);
  if (!reviewMatch) throw Error('Codex Coordinator returned no JSON assessment.');
  const codexReview = JSON.parse(reviewMatch[0]);
  if (!Number.isInteger(codexReview.score) || codexReview.score < 0 || codexReview.score > 100 || typeof codexReview.major_error !== 'boolean' || typeof codexReview.summary !== 'string' || codexReview.summary.length < 20) throw Error('Codex Coordinator assessment did not match the required schema.');
  manifest.codexReview = codexReview;
  if (perception.report.brief_alignment !== 'aligned' || perception.report.confidence < 25 || perception.report.issues.some(issue => issue.severity === 'major') || perception.audio_sha256 !== inspection.sha256) {
    codexReview.major_error = true;
    codexReview.score = Math.min(codexReview.score, 79);
    codexReview.summary += ' Coordinator gate: local listening/technical evidence failed a required acceptance check.';
  }
  manifest.codexReview = codexReview;
  const codexRecorded = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'record_codex_audio_review', {
    audio_path: generated.audio_path, project_id: runId, category: cue.category,
    perception_evidence_path: perception.evidence_path, score: codexReview.score,
    major_error: codexReview.major_error, summary: codexReview.summary
  }));
  manifest.codexRecordedReview = codexRecorded;
  await fs.copyFile(generated.manifest_path, candidateManifestCopy);
  audioProgress = { status: 'candidate_reviewed_by_coordinator', generated, inspection, perception, codexReview, codexRecorded };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (codexReview.score < 80 || codexReview.major_error) {
    manifest.status = 'candidate_review_failed';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ runId, status: manifest.status, candidatePath: generated.audio_path, score: codexReview.score }, null, 2));
    process.exitCode = 1;
  } else {
    manifest.finalizationStarted = true;
    manifest.status = 'finalization_started';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const filename = `component-${runId}.wav`;
    const finalized = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'finalize_audio', {
      audio_path: generated.audio_path, project_id: runId, category: cue.category, filename,
      perception_evidence_path: perception.evidence_path, perception_report: perception.report,
      codex_review: { score: codexReview.score, major_error: false, summary: codexReview.summary }
    }));
    if (finalized.status !== 'finalized' || !finalized.audio_path || !finalized.manifest_path) throw Error('Audio Worker did not finalize the passing candidate.');
    manifest.finalized = finalized;
    const finalCopy = path.join(runDirectory, filename);
    await fs.copyFile(finalized.audio_path, finalCopy);
    manifest.finalCopy = finalCopy;
    manifest.outputs.push(finalCopy);
    manifest.publicationStarted = true;
    manifest.status = 'publication_started';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const published = JSON.parse(await call(audioClient, 'audio-mcp-calls.jsonl', 'publish_audio', {
      audio_path: finalized.audio_path, project_id: runId, category: cue.category
    }, 600000));
    const finalizedBytes = (await fs.stat(finalized.audio_path)).size;
    if (published.status !== 'published' || Number(published.bytes_verified?.audio) !== finalizedBytes) throw Error('Audio Worker did not confirm publication and matching WAV size.');
    manifest.published = published;
    manifest.status = 'published';
    manifest.productionStarted = false;
    manifest.testAssetGenerationStarted = true;
    manifest.remotePath = published.remote_path;
    manifest.outputs.push(finalized.audio_path, finalized.manifest_path);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ runId, status: manifest.status, candidatePath: generated.audio_path, finalizedPath: finalized.audio_path, remotePath: published.remote_path, sha256: inspection.sha256, score: codexReview.score }, null, 2));
  }
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.stack;
  manifest.audioProgress = audioProgress;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.error(JSON.stringify({ runId, status: 'failed', error: error.message, runDirectory }, null, 2));
  process.exitCode = 1;
} finally {
  await projectClient.close().catch(() => {});
  await audioClient.close().catch(() => {});
}
