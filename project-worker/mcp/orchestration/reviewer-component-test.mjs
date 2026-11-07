import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LocalChatApi, reviewerInstruction } from './production.mjs';

const root = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.lmstudio');
const outputRoot = path.join(root, 'production-tests', 'components');
const configRoot = path.join(root, 'apps', 'bionic', '.internal', 'user-concrete-model-default-config');
const lms = path.join(root, 'bin', 'lms.exe');
const projectWorker = path.join(root, 'project-worker', 'mcp', 'server.mjs');
const clientApi = new LocalChatApi(lms);
const profiles = {
  'qwen3-8b': {
    model: 'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M (Narrative Reviewer).gguf',
    modelKey: 'qwen3-8b',
    config: path.join(configRoot, 'Qwen', 'Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M (Narrative Reviewer).gguf.json')
  },
  'qwen35-9b': {
    model: 'qwen/qwen3.5-9b',
    modelKey: 'qwen/qwen3.5-9b',
    config: path.join(configRoot, 'Qwen', 'qwen3.5-9b.json')
  }
};

const fixtures = {
  normal: {
    title: 'The Brass Key',
    canon: `## Canonical facts\n\n- Arin Vale is repairing a hand-cranked radio for Jo Sen.\n- Arin carries the small repair key in the left hand until placing it on the counter.\n- The repaired radio begins receiving Jo's familiar station at the exact scene endpoint.\n- The scene is grounded, non-romantic, and contains no graphic violence.`,
    brief: `Review this scene for canon, continuity, required actions, and endpoint. Arin must keep the repair key in the left hand until placing it on the counter. The scene must end immediately when the radio begins receiving Jo's familiar station.`,
    narrative: `## Scene: The Brass Key\n\nArin set the repair key on the counter beside the radio, then turned the brass dial with two fingers. Jo waited by the door, still wearing her rain-dark coat.\n\n"The station should come through now," Arin said.\n\nA soft crackle filled the shop, then Jo's familiar station began to play.\n\n"That's the one," Jo said. Arin smiled and promised to tune the radio again next week.\n\n## English Summary\n\nArin repairs the radio, and Jo recognizes her familiar station.`
  },
  hot: {
    title: 'Rain at the Cabin',
    canon: `## Canonical facts\n\n- Nessa and Rowan are fictional adults in a sober, established relationship.\n- Rowan wears a silver ring on the right hand and removes it before any intimate contact.\n- Both characters must explicitly agree before intimacy begins.\n- End after they pause together following intimacy; do not add future plans.`,
    brief: `Review this consensual adult romantic scene for consent, ring continuity, and endpoint. The ring must be removed before intimate contact, both adults must explicitly agree before intimacy begins, and the scene must end with their shared pause afterward without future plans.`,
    narrative: `## Scene: Rain at the Cabin\n\nNessa shut the cabin door against the rain and kissed Rowan. Rowan's right hand settled at her waist; the silver ring pressed cool against Nessa's side.\n\n"I want you," Nessa whispered. Rowan answered by kissing her again, and their closeness deepened. Only then did Rowan notice the ring, slip it from the right hand, and set it on the table.\n\nThey moved together slowly, checking each other's faces and words as the storm softened outside. Afterward they rested shoulder to shoulder beneath a blanket.\n\n"Should we book the same cabin next month?" Nessa asked. Rowan nodded.\n\n## English Summary\n\nNessa and Rowan share a consensual intimate evening and plan another trip.`
  },
  violent: {
    title: 'The Market Awning',
    canon: `## Canonical facts\n\n- Mara is an adult emergency medic; Lena is the adult patient with one severe bleeding leg wound.\n- Mara keeps Lena conscious by speaking to her while applying a red field bandage from the open medical kit.\n- Rescue workers take over care at the scene endpoint.\n- The injury is fictional and graphic, with no sexual violence or second injury.`,
    brief: `Review for the required treatment, patient continuity, and exact endpoint. Mara must use the red field bandage from the open kit and keep Lena conscious by speaking to her. End immediately when rescue workers take over. Do not add another injury.`,
    narrative: `## Scene: The Market Awning\n\nMara knelt beside Lena beneath the collapsed awning. The deep cut on Lena's calf bled through her torn trouser leg, darkening the mud.\n\n"Stay with me, Lena. Tell me what you can hear," Mara said. Lena answered through clenched teeth while Mara opened the medical kit and wrapped the leg in a white pressure bandage.\n\nThe rescue workers arrived with a stretcher. Mara gave them the patient's name and wound location, then stepped back as they took over Lena's care. The team lifted the stretcher and carried Lena toward the ambulance. Mara followed them through the market and climbed into the ambulance beside her.\n\n## English Summary\n\nMara keeps Lena conscious and treats her leg until rescue workers take over.`
  }
};

const expected = {
  normal: [
    'The repair key is placed on the counter before the required endpoint, contrary to the left-hand continuity.',
    'The scene continues with dialogue and a promise after the radio receives the station.'
  ],
  hot: [
    'Kissing and intimate contact start before the right-hand ring is removed.',
    'The scene provides no explicit mutual agreement before intimacy begins.',
    'The scene adds a future trip plan after the requested post-intimacy pause.'
  ],
  violent: [
    'Mara uses a white bandage instead of the required red field bandage.',
    'The narrative continues after rescue workers take over by moving into the ambulance.'
  ]
};

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
function makeRunId() { return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${crypto.randomBytes(6).toString('hex')}`; }

const profileId = arg('--reviewer-profile');
const testCase = arg('--reviewer-case');
const comparisonSeed = arg('--comparison-seed');
const fixtureSet = arg('--fixture-set') || 'baseline';
if (!profiles[profileId]) throw Error(`Choose --reviewer-profile ${Object.keys(profiles).join('|')}`);
const activeFixtures = fixtureSet === 'baseline' ? fixtures : null;
if (!activeFixtures) throw Error('Choose --fixture-set baseline');
if (!activeFixtures[testCase]) throw Error(`Choose --reviewer-case ${Object.keys(activeFixtures).join('|')}`);
if (!comparisonSeed || !/^[a-f0-9]{16}$/.test(comparisonSeed)) throw Error('--comparison-seed must be a shared 16-character lowercase hexadecimal fixture ID');

const profile = profiles[profileId];
const config = JSON.parse(await fs.readFile(profile.config, 'utf8'));
const reviewerSystem = JSON.parse(await fs.readFile(profiles['qwen3-8b'].config, 'utf8')).operation.fields.find(field => field.key === 'llm.prediction.systemPrompt')?.value;
if (!reviewerSystem) throw Error('The Narrative Reviewer system prompt is missing from its configured Qwen3 8B profile');
const reviewerConfig = {
  operation: {
    fields: [
      { key: 'llm.prediction.temperature', value: 0.6 },
      { key: 'llm.prediction.topKSampling', value: 20 },
      { key: 'llm.prediction.reasoning.enableThinking', value: false },
      { key: 'llm.prediction.repeatPenalty', value: { checked: true, value: 1.05 } },
      { key: 'llm.prediction.minPSampling', value: { checked: true, value: 0 } },
      { key: 'llm.prediction.systemPrompt', value: reviewerSystem }
    ]
  },
  load: { fields: [{ key: 'llm.load.contextLength', value: 8192 }, { key: 'llm.load.numParallelSessions', value: 1 }] }
};

const runId = makeRunId();
const runDirectory = path.join(outputRoot, runId);
await fs.mkdir(runDirectory, { recursive: true });
const fixture = activeFixtures[testCase];
const activeExpected = expected;
const prompt = reviewerInstruction(fixture.canon, fixture.brief, fixture.narrative, []);
const startedAt = new Date().toISOString();
const started = performance.now();
const manifest = {
  runId, seed: runId, comparisonSeed, fixtureSet, role: 'reviewer', reviewerProfile: profileId, reviewerCase: testCase,
  model: profile.model, modelKey: profile.modelKey, modelConfig: profile.config,
  sharedReviewerPromptSource: profiles['qwen3-8b'].config,
  predictionSettings: reviewerConfig.operation.fields.filter(field => field.key !== 'llm.prediction.systemPrompt'),
  loadSettings: reviewerConfig.load.fields, contextLength: 8192, temperature: 0.6, reasoning: 'off',
  mode: 'isolated-component', fixtureId: `${testCase}-${comparisonSeed}`, status: 'started',
  productionStarted: false, revisionStarted: false, assetGenerationStarted: false, implementationStarted: false,
  createdAt: startedAt
};
await fs.writeFile(path.join(runDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(runDirectory, 'review-request.json'), JSON.stringify({ prompt, systemPrompt: reviewerSystem, sharedFixture: fixture }, null, 2) + '\n');
await fs.writeFile(path.join(runDirectory, 'evaluation-key.md'), `# Reviewer Evaluation Key: ${fixture.title}\n\nDo not include this key in the model prompt. Expected findings:\n\n${activeExpected[testCase].map((finding, index) => `${index + 1}. ${finding}`).join('\n')}${testCase === 'violent' ? '\n\nCompliance control: Mara explicitly asks Lena to stay with her and Lena answers during treatment. Reporting that the patient is not kept conscious is a false positive.' : ''}\n\nEvaluate whether the response identifies each seeded issue, quotes exact narrative evidence, gives a localized actionable correction, avoids false positives, follows the verdict format, and avoids rewriting the scene.\n`);

const mcpCalls = [];
const client = new Client({ name: 'bionic-reviewer-component-test', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [projectWorker], stderr: 'pipe', env: { ...process.env, BIONIC_PROJECTS_DIR: runDirectory } });
try {
  await client.connect(transport);
  const initialContent = `## Reviewer Test Fixture\n\n### Canon\n\n${fixture.canon}\n\n### Approved brief\n\n${fixture.brief}\n\n### Narrative under review\n\n${fixture.narrative}\n\n### Test boundary\n\nReview only. Do not revise prose or start production.\n`;
  const created = await client.callTool({ name: 'create_project_file', arguments: { project_name: `reviewer-${testCase}-${runId}`, initial_content: initialContent } });
  mcpCalls.push({ tool: 'create_project_file', result: created });
  const createText = created.content?.map(block => block.text || '').join('\n') || '';
  const filename = createText.match(/PROJECT_FILE:\s*(\S+\.md)/)?.[1];
  if (!filename) throw Error(`Project Worker did not create the reviewer fixture Project File: ${createText}`);
  const readback = await client.callTool({ name: 'read_project_file', arguments: { filename } });
  mcpCalls.push({ tool: 'read_project_file', result: readback });
  if (readback.isError || !readback.content?.some(block => block.text?.includes(fixture.narrative) && block.text?.includes(fixture.canon))) throw Error('Project File read-back did not preserve the fixture canon and narrative');

  await clientApi.ensure();
  const response = await fetch('http://127.0.0.1:1234/api/v1/models', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error(`Cannot inspect LM Studio model instances: HTTP ${response.status}`);
  const inventory = await response.json();
  const loaded = (inventory.models || []).filter(model => model.type === 'llm' && model.loaded_instances?.length);
  const matching = loaded.filter(model => model.key === profile.modelKey);
  if (loaded.length !== 1 || matching.length !== 1 || matching[0].loaded_instances.length !== 1) throw Error(`Expected exactly one loaded instance of ${profile.modelKey}; found ${loaded.map(model => `${model.key} (${model.loaded_instances?.length || 0})`).join(', ') || 'none'}`);
  const instance = matching[0].loaded_instances[0];
  manifest.modelInstance = { id: instance.id, modelKey: matching[0].key, displayName: matching[0].display_name, quantization: matching[0].quantization, sizeBytes: matching[0].size_bytes, contextLength: instance.config?.context_length };
  await fs.writeFile(path.join(runDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const predictionStarted = performance.now();
  const result = await clientApi.predict(instance.id, prompt, reviewerSystem, reviewerConfig, 'reviewer', { contextLength: 8192 });
  const predictionElapsedMs = Math.round(performance.now() - predictionStarted);
  const elapsedMs = Math.round(performance.now() - started);
  await fs.writeFile(path.join(runDirectory, 'review-output.md'), result.text + '\n');
  await fs.writeFile(path.join(runDirectory, 'review-output.raw.json'), JSON.stringify(result, null, 2) + '\n');
  const recording = await client.callTool({ name: 'record_component_test', arguments: {
    run_id: runId, role: 'reviewer', input: prompt.slice(0, 12000), model: profile.model,
    response: result.text, interaction: 'analysis', mock_reply: 'Reviewer-only evaluation complete. No revision or production follows.'
  } });
  mcpCalls.push({ tool: 'record_component_test', result: recording });
  if (recording.isError) throw Error(recording.content?.map(block => block.text || '').join('\n') || 'Project Worker did not record the Reviewer response');
  await fs.writeFile(path.join(runDirectory, 'mcp-calls.json'), JSON.stringify(mcpCalls, null, 2) + '\n');
  Object.assign(manifest, {
    status: 'completed_pending_review', completedAt: new Date().toISOString(), elapsedMs, predictionElapsedMs,
    predictionStats: result.stats || null, responseIdStored: result.responseIdStored,
    projectFile: filename, projectFilePath: path.join(runDirectory, filename),
    outputPath: path.join(runDirectory, 'review-output.md'),
    outputTokensPerSecond: result.stats?.tokens_per_second ?? null,
    productionStarted: false, revisionStarted: false, assetGenerationStarted: false, implementationStarted: false
  });
  await fs.writeFile(path.join(runDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(runDirectory, 'input.md'), `# Reviewer Component Test: ${profileId} / ${testCase}\n\n## Canon\n\n${fixture.canon}\n\n## Approved brief\n\n${fixture.brief}\n\n## Narrative under review\n\n${fixture.narrative}\n\n## Review\n\n${result.text}\n`);
  console.log(JSON.stringify({ runId, role: 'reviewer', reviewerProfile: profileId, reviewerCase: testCase, comparisonSeed, elapsedMs, tokensPerSecond: result.stats?.tokens_per_second ?? null, outputDirectory: runDirectory, status: 'completed' }, null, 2));
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.message;
  manifest.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(runDirectory, 'mcp-calls.json'), JSON.stringify(mcpCalls, null, 2) + '\n').catch(() => {});
  await fs.writeFile(path.join(runDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n').catch(() => {});
  throw error;
} finally {
  await transport.close().catch(() => {});
  await clientApi.stopIfOwned().catch(() => {});
}

