import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { predictRole, writerInstruction, narrativeContentChecks, narrativePresentationChecks } from '../../project-worker/mcp/orchestration/production.mjs';

const root = process.env.USERPROFILE + '\\.lmstudio';
const out = path.join(root, 'production-tests', 'writer-model-comparison');
const promptDir = path.join(out, 'prompts');
const optimizedSystem = (await fs.readFile(path.join(promptDir, 'writer-system-optimized.txt'), 'utf8')).trim();
const legacySystem = (await fs.readFile(path.join(promptDir, 'writer-system-current-before.txt'), 'utf8')).trim();
const catalog = JSON.parse((await (await import('node:child_process')).execFileSync(path.join(root, 'bin', 'lms.exe'), ['ls', '--json'], {encoding:'utf8'})));
const project = `# Project File excerpt\n\n## Character Profile\nAlex is 28, blonde, sarcastic, sociable, and normally wears a black leather jacket. The receptionist is an adult woman.\n\n## Tone\nPlayful, comic, lightly flirtatious, and warm. Both characters are adults. No established facts beyond these.\n\n## Visual Asset Specification\nOne hotel reception image.`;
const brief = `Write the approved test scene at the hotel reception. In English, aim for 300–330 narrative words, 250–400 allowed, excluding headings, Visual and Italian summary. One continuous interaction; no room scene or time jump. Required beats in order: receptionist says something Alex can reasonably mistake for a romantic offer; Alex responds as if she is flirting; receptionist explicitly clarifies in spoken dialogue that she means the drinks/snacks in the room minibar, not a personal offer; Alex answers with a clear comic beat. Keep it playful and mildly flirtatious. One opening Visual directive. No Choice or actual audio. Preserve Alex's canon. Include a brief accurate Italian production summary after the scene.`;
const task = writerInstruction(project, brief);
await fs.writeFile(path.join(promptDir, 'scene-task.txt'), task, 'utf8');
const scaffoldTask = `${task}\n\nComposition pass: silently plan the four required story beats as setup, build, misunderstanding, and comic payoff. Write a complete scene with enough distinct reactions and dialogue to reach at least 250 narrative words (target 300–330). Use several exchanges before and after the clarification; do not pad, repeat, introduce a new character name, location, or event, or end on an unearned romantic claim. Count only narrative prose/dialogue, not the Visual or Italian summary.`;
await fs.writeFile(path.join(promptDir, 'scene-task-scaffold.txt'), scaffoldTask, 'utf8');
const models = {
  writer: catalog.find(m => m.type === 'llm' && /writer.*27b|27b.*writer/i.test(m.displayName)),
  hemmingway: catalog.find(m => m.type === 'llm' && /hemmingway.*extreme/i.test(m.displayName)),
  mistral: catalog.find(m => m.type === 'llm' && /mistral.*small.*3\.2/i.test(m.displayName))
};
for (const name of ['writer', 'mistral']) if (!models[name]) throw new Error(`Missing catalog entry for ${name}`);
const rows = [
  {name:'writer-current-system', model:models.writer, system:legacySystem},
  {name:'writer-optimized-system', model:models.writer, system:optimizedSystem, overrides:{}},
  {name:'writer-optimized-thinking', model:models.writer, system:optimizedSystem, overrides:{'llm.prediction.reasoning.enableThinking':true}},
  {name:'mistral-optimized-system', model:models.mistral, system:optimizedSystem},
  {name:'writer-lengthguard', model:models.writer, system:optimizedSystem},
  {name:'mistral-lengthguard', model:models.mistral, system:optimizedSystem},
  {name:'mistral-lengthguard-lowtemp', model:models.mistral, system:optimizedSystem, overrides:{'llm.prediction.temperature':0.15}},
  {name:'writer-scaffold', model:models.writer, system:optimizedSystem, prompt:scaffoldTask},
  ...(models.hemmingway ? [{name:'hemmingway-scaffold', model:models.hemmingway, system:optimizedSystem, prompt:scaffoldTask}] : [])
];
const manifest = {startedAt:new Date().toISOString(), taskSha256:crypto.createHash('sha256').update(task).digest('hex'), skipped:models.hemmingway ? [] : [{name:'hemmingway-scaffold', reason:'GGUF file exists but LM Studio CLI does not index the model, so the supported inference path cannot load it.'}], rows:[]};
try {
  const previous = JSON.parse(await fs.readFile(path.join(out, 'benchmark-results.json'), 'utf8'));
  if (previous.taskSha256 === manifest.taskSha256) {
    manifest.rows = previous.rows || [];
    for (const done of manifest.rows) {
      const priorText = await fs.readFile(done.outputFile, 'utf8');
      done.words = priorText.split(/\s+/).filter(Boolean).length;
      done.contentChecks = narrativeContentChecks(priorText);
      done.presentationChecks = narrativePresentationChecks(priorText);
    }
  }
} catch {}
for (const row of rows) {
  if (manifest.rows.some(done => done.name === row.name)) {
    process.stdout.write(`${row.name}: already complete; keeping saved result\n`);
    continue;
  }
  const events=[];
  const rowTask = row.prompt || task;
  const text=await predictRole('writer', rowTask, {jobId:`writer-benchmark-${row.name}`, catalog, modelIdentifierOverride:row.model.indexedModelIdentifier, systemPromptOverride:row.system, predictionOverrides:row.overrides, record:async event=>events.push(event)});
  const file=path.join(out, `${row.name}.md`);
  await fs.writeFile(file, text, 'utf8');
  manifest.rows.push({name:row.name, model:row.model.displayName, identifier:row.model.indexedModelIdentifier, outputFile:file, settings:row.overrides||{temperature:0.78,repeatPenalty:1.02}, systemPromptSha256:crypto.createHash('sha256').update(row.system).digest('hex'), taskSha256:crypto.createHash('sha256').update(rowTask).digest('hex'), words:text.split(/\s+/).filter(Boolean).length, contentChecks:narrativeContentChecks(text), presentationChecks:narrativePresentationChecks(text), events});
  await fs.writeFile(path.join(out, 'benchmark-results.json'), JSON.stringify(manifest,null,2), 'utf8');
  process.stdout.write(`${row.name}: complete; ${manifest.rows.at(-1).words} total whitespace words; ${manifest.rows.at(-1).contentChecks.length} content checks; ${manifest.rows.at(-1).presentationChecks.length} presentation checks\n`);
}
manifest.finishedAt=new Date().toISOString();
await fs.writeFile(path.join(out, 'benchmark-results.json'), JSON.stringify(manifest,null,2), 'utf8');
