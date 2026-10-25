import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, MemoryManager } from './bionic.mjs';
import { createSceneContract, predictRole } from './production.mjs';

const root = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Shadow', '.lmstudio');
const lms = path.join(root, 'bin', 'lms.exe');
const outputRoot = path.join(root, 'production-tests', 'components');
const runId = `planner-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
const runRoot = path.join(outputRoot, runId);
const fixtures = [
  {
    name: 'normal-handoff', pairSeed: crypto.randomUUID(), repeat: 1,
    fixture: {
      scene_id: 'planner_fixture_archive_compass', mode: 'normal',
      approved_brief: 'Plan one grounded, non-romantic scene in English. Etta Vale, age 29, is closing a small public archive during a snowstorm. Jo Senn, age 41, arrives to return a repaired brass compass. Show the return and end immediately when the compass needle settles pointing north.',
      canon: {
        facts: ['The brass compass has a cracked glass face.','Etta holds the tiny repair pin in her right hand until she places it in the blue tray after the handoff.','Jo is returning the repaired compass.'],
        unknowns: ['The compass’s previous owner and history are unspecified.','The archive’s town and address are unspecified.']
      },
      constraints: ['No romance, sexual content, graphic violence, or additional named characters.','Do not invent compass history or a reason for the crack.','The ending occurs the moment the needle settles pointing north.']
    }
  },
  {
    name: 'complex-timeline-privacy', pairSeed: crypto.randomUUID(), repeat: 1,
    fixture: {
      scene_id: 'planner_fixture_eclipse_note', mode: 'normal',
      approved_brief: 'Plan a scene that begins at 2:12 a.m. and ends at dawn after Ada and Brin witness the eclipse-shadow leave the observatory lens together. Their first personal conversation is at the east train platform. Ada invites Brin in person to return for the observation, and Brin clearly accepts.',
      canon: {
        facts: [
          'At 2:12 a.m. Ada writes exactly: “Meet me where the sky turns copper.”',
          'Ada seals the note at 2:12 a.m. without reading it aloud.',
          'At 2:19 a.m. a sorting machine reads the note once; only Ada is present and hears it.',
          'At 2:23 a.m. the station log records only received_at=2:23 and source=sorting_machine.',
          'Brin has not seen or heard the note and does not know its wording.',
          'Ada and Brin’s first personal conversation takes place at the east train platform.',
          'At dawn they witness the eclipse-shadow leave the observatory lens together.'
        ],
        knownByCharacter: { Ada: ['She wrote and sealed the note.','She alone heard the sorting machine read it.'], Brin: ['Brin has not seen or heard the note.'] },
        unknowns: ['The note’s delivery destination is unspecified.','The observatory’s town, equipment details, and prior eclipse history are unspecified.','The station log contains no note text.']
      },
      constraints: [
        'Do not let Brin know, quote, or react to the private note.',
        'Do not imply Ada read the note aloud; the machine reading is the only playback and only Ada hears it.',
        'Do not expose note wording in the station log.',
        'Do not invent prior meetings, other named characters, or eclipse history.',
        'Show the first conversation at the east train platform, the in-person invitation and clear acceptance, then the shared dawn observation before ending.'
      ]
    }
  },
  {
    name: 'adult-consent', pairSeed: crypto.randomUUID(), repeat: 1,
    fixture: {
      scene_id: 'planner_fixture_cabin_ribbon', mode: 'adult',
      approved_brief: 'Plan an explicitly consensual erotic scene between fictional adults Iria Sol, age 34, and Venn Arlo, age 37, established partners of three years, alone in their rented lakeside cabin after a difficult journey. Both are sober and freely choose intimacy. End when they pause together after intimacy; add no future plans.',
      canon: {
        facts: ['Iria and Venn are adults and have been partners for three years.','Iria wears a yellow ribbon around her right wrist.','Iria removes the ribbon before intimate contact.'],
        unknowns: ['Their appearance, earlier relationship history, and future plans are unspecified.']
      },
      constraints: ['No coercion, intoxication, age ambiguity, or other characters.','Do not begin intimate contact before Iria removes the ribbon.','The ending is their pause together after intimacy.','Do not alter their relationship status or add future plans.']
    }
  },
  {
    name: 'complex-timeline-privacy-repeat', pairSeed: null, repeat: 2,
    fixture: null
  }
];
fixtures[3].fixture = JSON.parse(JSON.stringify(fixtures[1].fixture));
fixtures[3].fixture.scene_id = 'planner_fixture_eclipse_note_repeat';
fixtures[3].pairSeed = crypto.randomUUID();

const execute = async (args, timeoutMs = 30000) => {
  const result = await run(lms, args, { timeoutMs });
  if (result.code !== 0) throw Error((result.stderr || result.stdout || 'LM Studio CLI failed').trim());
  return result.stdout;
};
const record = async (dir, event) => {
  const file = path.join(dir, 'evidence.jsonl');
  await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
};
await fs.mkdir(runRoot, { recursive: true });
const memory = new MemoryManager(lms, run);
const alreadyLoaded = await memory.list();
if (alreadyLoaded.length) throw Error(`Planner component test requires free LM Studio memory; loaded: ${alreadyLoaded.map(item => item.identifier).join(', ')}`);
const catalog = JSON.parse(await execute(['ls', '--json']));
const qwen = catalog.find(model => model.type === 'llm' && /narrative reviewer/i.test(model.displayName));
if (!qwen) throw Error('The Qwen Narrative Reviewer model is not available in the LM Studio catalog');
const qwenConfigPath = path.join(root, 'apps', 'bionic', '.internal', 'user-concrete-model-default-config', qwen.indexedModelIdentifier + '.json');
const qwenConfig = JSON.parse(await fs.readFile(qwenConfigPath, 'utf8'));
const manifest = {
  runId, role: 'scene-planner', testMode: 'component', status: 'started', createdAt: new Date().toISOString(),
  models: {
    qwen: { displayName: qwen.displayName, indexedModelIdentifier: qwen.indexedModelIdentifier, modelKey: qwen.modelKey, configPath: qwenConfigPath, config: qwenConfig.operation.fields.filter(field => field.key !== 'llm.prediction.systemPrompt'), contextLength: 8192, gpu: 'max', parallel: 1 },
    codex: { cliVersion: (await run('codex', ['--version'])).stdout.trim(), model: 'configured Codex CLI model' }
  },
  outputs: [], productionStarted: false, writerStarted: false, assetsStarted: false
};
await fs.writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
try {
  for (const item of fixtures) {
    const caseId = `${item.name}-rep${item.repeat}`;
    const caseDir = path.join(runRoot, caseId);
    await fs.mkdir(caseDir, { recursive: true });
    const fixture = { ...item.fixture, scene_id: `${item.fixture.scene_id}-${runId}` };
    const pairSeed = item.pairSeed;
    await fs.writeFile(path.join(caseDir, 'fixture.json'), JSON.stringify({ pairSeed, samplerSeedApplied: false, fixture }, null, 2), { flag: 'wx' });
    const caseRecord = async event => record(caseDir, event);
    const predict = (role, prompt, options = {}) => predictRole(role, prompt, {
      jobId: `${runId}-${caseId}`, record: caseRecord, runner: run, memory, catalog, ...options
    });
    const codexPlanner = async (prompt, outputPath, options) => {
      const { runCodexPlanner } = await import('./production.mjs');
      return runCodexPlanner(prompt, outputPath, options);
    };
    const startedAt = new Date().toISOString();
    await caseRecord({ stage: 'scene_planning', event: 'component_case_started', caseId, pairSeed, repeat: item.repeat });
    const result = await createSceneContract({
      sceneId: fixture.scene_id, canonical: JSON.stringify(fixture.canon, null, 2),
      summary: fixture.approved_brief + '\nConstraints: ' + fixture.constraints.join(' '), out: caseDir,
      predict, codexPlanner, record: caseRecord
    });
    const output = {
      caseId, pairSeed, repeat: item.repeat, fixture, startedAt, completedAt: new Date().toISOString(),
      contractPath: result.path, contractSha256: result.sha256, contract: result.contract,
      qwenProposalPath: path.join(caseDir, 'scene-contract-qwen-proposal.json'),
      codexProposalPath: path.join(caseDir, 'scene-contract-codex-proposal.json'),
      qwenProposal: JSON.parse(await fs.readFile(path.join(caseDir, 'scene-contract-qwen-proposal.json'), 'utf8')),
      codexProposal: JSON.parse(await fs.readFile(path.join(caseDir, 'scene-contract-codex-proposal.json'), 'utf8')),
      status: 'completed'
    };
    manifest.outputs.push(output);
    await caseRecord({ stage: 'scene_planning', event: 'component_case_completed', caseId, contractSha256: result.sha256 });
    await fs.writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  manifest.localModelsAfter = await memory.list();
  if (manifest.localModelsAfter.length) throw Error('Planner test left a local model loaded');
  manifest.status = 'completed';
  manifest.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ runId, runRoot, status: manifest.status, cases: manifest.outputs.map(item => item.caseId), qwen: qwen.displayName, codex: manifest.models.codex }, null, 2));
} catch (error) {
  manifest.status = 'failed';
  manifest.error = String(error.stack || error);
  manifest.localModelsAfter = await memory.list().catch(() => []);
  await fs.writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.error(JSON.stringify({ runId, runRoot, status: manifest.status, error: error.message }, null, 2));
  process.exitCode = 1;
}
