import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LocalChatApi, predictRole, reviewerInstruction, reviewVerdict,
  reviewPassEvidenceIssues, reviewFindingEvidenceIssues,
  narrativeContentChecks, narrativePresentationChecks,
  writerRevisionScopeChecks, stripPresentationOnlyFindings
} from '../project-worker/mcp/orchestration/production.mjs';

const root = path.join(process.env.USERPROFILE, '.lmstudio');
const output = path.join(root, 'docs', 'confronto-modelli-narrazione');
const promptDir = path.join(root, 'production-tests', 'writer-model-comparison', 'prompts');
const writerSystem = (await fs.readFile(path.join(promptDir, 'writer-system-optimized.txt'), 'utf8')).trim();
const catalog = JSON.parse((await (await import('node:child_process')).execFileSync(path.join(root, 'bin', 'lms.exe'), ['ls', '--json'], { encoding: 'utf8' })));
const candidates = [
  { slug: 'qwen-writer', match: /Qwen3\.5 27B Writer v2/i },
  { slug: 'mistral-small', match: /Mistral Small 3\.2 24B/i },
  { slug: 'hemmingway', match: /Hemmingway1 Extreme/i }
].map(candidate => ({ ...candidate, model: catalog.find(item => item.type === 'llm' && candidate.match.test(item.displayName)) }));
if (candidates.some(candidate => !candidate.model)) throw new Error('One or more Writer candidates are not indexed in the LM Studio CLI catalog');

const canonical = `# Project File excerpt\n\n## Character Profile\nAlex is 28, blonde, sarcastic, sociable, and normally wears a black leather jacket. The receptionist is an adult woman.\n\n## Tone\nPlayful, comic, lightly flirtatious, and warm. Both characters are adults. No established facts beyond these.\n\n## Visual Asset Specification\nOne hotel reception image.`;
const brief = `Write one complete scene in English set entirely at the hotel reception. Narrative body: 250–400 words, excluding title, Visual directive, and Italian summary. This is a range, not a target or exact word count; any natural length inside it is acceptable. Use one continuous interaction and no time jump, room scene, extra character name, unsupported canon, or Choice. Required beats in order: (1) the receptionist says something Alex can reasonably mistake for a romantic offer; (2) Alex responds as if she is flirting; (3) she explicitly clarifies in spoken dialogue that she means the drinks/snacks in the room minibar and that this is not a personal or romantic offer; (4) Alex answers with a clear comic payoff. Keep it playful and mildly flirtatious. Preserve Alex's canon. Include one opening Visual directive and a brief accurate Italian production summary after the scene. Make the misunderstanding plausible but resolve it clearly.`;
const baseTask = `CANONICAL FACTS:\n${canonical}\n\nAPPROVED SCENE BRIEF:\n${brief}\n\nWrite only the requested complete scene. Use a natural range of 250–400 narrative words; do not aim for a particular number. Include the title, ## Narrative, one opening > Visual: directive, prose with **Speaker:** dialogue labels, and ## Italian Summary. Return only the artifact.`;
const correctionTask = (draft, feedback) => `${baseTask}\n\n<previous_draft_to_revise>\n${draft}\n</previous_draft_to_revise>\n\n<reviewer_feedback>\n${feedback}\n</reviewer_feedback>\n\nThis is a localized revision. Preserve every sound passage and strong line. Correct the reviewer's evidence-backed content findings, keep all unaffected dialogue and prose, and stay naturally within 250–400 narrative words. Do not rewrite the whole scene or add unrelated material. Return the complete revised artifact only.`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const narrativeBody = text => text.split(/## Narrative\s*\r?\n/i)[1]?.split(/## Italian Summary/i)[0] || '';
const countWords = text => narrativeBody(text).replace(/^>.*$/gm, '').trim().split(/\s+/).filter(Boolean).length;
const priorManifest = await fs.readFile(path.join(output, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
const rows = priorManifest?.rows || [];
const startedAt = priorManifest?.startedAt || new Date().toISOString();
const chatApi = new LocalChatApi();
const manifestPath = path.join(output, 'manifest.json');
await fs.mkdir(output, { recursive: true });
const saveManifest = async () => fs.writeFile(manifestPath, JSON.stringify({
  title: 'Confronto modelli di narrazione', startedAt, finishedAt: null,
  range: { minimumNarrativeWords: 250, maximumNarrativeWords: 400, exactTarget: null },
  reviewer: 'Qwen3 8B Narrative Reviewer using the configured Project Worker review prompt',
  codex: 'Independent final review and localized final edit recorded after the model runs',
  writerSystemSha256: sha(writerSystem), briefSha256: sha(brief), rows
}, null, 2), 'utf8');
await saveManifest();

try {
  for (const candidate of candidates) {
    const dir = path.join(output, candidate.slug);
    await fs.mkdir(dir, { recursive: true });
    let row = rows.find(item => item.slug === candidate.slug);
    if (row && row.status !== 'running') continue;
    if (!row) {
      row = { slug: candidate.slug, model: candidate.model.displayName, identifier: candidate.model.indexedModelIdentifier,
        fileBytes: candidate.model.sizeBytes, quantization: candidate.model.quantization?.name,
        settings: { temperature: 0.78, repeatPenalty: 1.02, contextLength: 8192 },
        stages: [], status: 'running' };
      rows.push(row);
    }
    const recordFor = stage => async event => { row.stages.push({ stage, ...event }); await saveManifest(); };
    const generate = async (stage, prompt, role = 'writer') => {
      const text = await predictRole(role, prompt, {
        jobId: `comparison-${candidate.slug}-${stage}-${crypto.randomUUID()}`,
        catalog, modelIdentifierOverride: role === 'writer' ? candidate.model.indexedModelIdentifier : null,
        systemPromptOverride: role === 'writer' ? writerSystem : null,
        predictionOverrides: role === 'writer' ? {
          'llm.prediction.temperature': 0.78,
          'llm.prediction.repeatPenalty': 1.02
        } : {},
        chatApi, record: recordFor(stage)
      });
      return text;
    };
    const saveSample = async (name, text, data = {}) => {
      const file = path.join(dir, `${name}.md`);
      await fs.writeFile(file, text, 'utf8');
      return { file, narrativeWords: countWords(text), contentChecks: narrativeContentChecks(text),
        presentationChecks: narrativePresentationChecks(text), sha256: sha(text), ...data };
    };

    // Base-only generation, separate from the complete review workflow.
    const base = await generate('base-writer', baseTask);
    row.base = await saveSample('base', base);
    await saveManifest();

    // Independent full-workflow draft, followed by the actual local Narrative Reviewer.
    let draft = await generate('full-writer-1', baseTask);
    row.full = { cycles: [], correctionCount: 0 };
    row.full.cycles.push({ draft: await saveSample('full-writer-1', draft) });
    let accepted = false;
    for (let cycle = 1; cycle <= 3; cycle++) {
      const checks = narrativeContentChecks(draft);
      const words = countWords(draft);
      if (words > 400) checks.push(`Narrative body is ${words} words; maximum is 400.`);
      let reviewPrompt = reviewerInstruction(canonical, brief, draft, checks);
      if (cycle === 1) reviewPrompt += `\n\nCOMPARATIVE REVISION TEST: Each candidate must receive and perform at least one genuine localized Writer correction. If all mandatory checks pass, identify one real, evidence-backed improvement to the weakest required beat or its causal connection; do not invent a defect or request cosmetic changes. Return REVISION REQUIRED with an exact NARRATIVE_EVIDENCE quote and a concise localized request. Do not pass this first review without either a substantive correction or this one craft improvement.`;
      let review = await generate(`reviewer-${cycle}`, reviewPrompt, 'reviewer');
      const filtered = stripPresentationOnlyFindings(review, draft);
      review = filtered.review;
      const verdict = reviewVerdict(review);
      const evidenceChecks = verdict === 'PASS' ? reviewPassEvidenceIssues(review, draft) : reviewFindingEvidenceIssues(review, draft, checks);
      const reviewSample = await saveSample(`reviewer-${cycle}`, review, { verdict, evidenceChecks, mechanicallyFlagged: checks });
      row.full.cycles.at(-1).review = reviewSample;
      await saveManifest();

      // Always perform one corrective Writer pass in each complete test. Later cycles run only if Reviewer has not approved.
      if (cycle === 1 || verdict !== 'PASS' || checks.length || evidenceChecks.length) {
        const feedback = `${review}\n\nDeterministic content findings:\n${checks.join('\n') || 'None.'}\n\nEvidence validation findings:\n${evidenceChecks.join('\n') || 'None.'}\n\n${cycle === 1 && verdict === 'PASS' ? 'The comparative test still requires one localized improvement. Preserve the approved story; strengthen only the weakest beat or its causal connection, without adding plot facts.' : ''}`;
        const revised = await generate(`writer-revision-${cycle}`, correctionTask(draft, feedback));
        const revisionData = await saveSample(`writer-revision-${cycle}`, revised, {
          scopeChecks: writerRevisionScopeChecks(draft, revised),
          changedFromPreviousSha256: sha(draft)
        });
        row.full.cycles.at(-1).revision = revisionData;
        row.full.correctionCount++;
        await saveManifest();
        draft = revised;
        row.full.cycles.push({ draft: await saveSample(`full-writer-${cycle + 1}`, draft) });
        await saveManifest();
      }
      if (cycle > 1 && verdict === 'PASS' && !checks.length && !evidenceChecks.length) { accepted = true; break; }
      if (cycle === 3 && verdict === 'PASS' && !checks.length && !evidenceChecks.length) accepted = true;
    }
    row.full.reviewerApproved = accepted;
    row.full.finalReviewerDraft = path.join(dir, `full-writer-${row.full.cycles.length}.md`);
    row.status = accepted ? 'reviewer-approved-awaiting-codex' : 'reviewer-not-approved-awaiting-codex';
    await saveManifest();
  }
} finally {
  await chatApi.stopIfOwned();
  const final = {
    title: 'Confronto modelli di narrazione', startedAt, finishedAt: new Date().toISOString(),
    range: { minimumNarrativeWords: 250, maximumNarrativeWords: 400, exactTarget: null },
    reviewer: 'Qwen3 8B Narrative Reviewer using the configured Project Worker review prompt',
    codex: 'Independent final review and localized final edit recorded after the model runs',
    writerSystemSha256: sha(writerSystem), briefSha256: sha(brief), rows
  };
  await fs.writeFile(manifestPath, JSON.stringify(final, null, 2), 'utf8');
}
process.stdout.write(`Completed ${rows.length} model comparisons. Results: ${output}\n`);
