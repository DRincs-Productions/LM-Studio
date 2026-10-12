import test from 'node:test';
import assert from 'node:assert/strict';
import { narrativeContentChecks, narrativePresentationChecks, reviewPassEvidenceIssues, deterministicImagePlan, imageDimensionsForJob, codexNarrativeEditBudgetIssues, writerRevisionScopeChecks, stripPresentationOnlyFindings } from '../../project-worker/mcp/orchestration/production.mjs';

const baseNarrative = `# Scene: Test\n\n## Narrative\n\n> Visual: Two adults at a hotel desk.\n\nThe brass bell sat between them. Alex studied the receptionist's smile and mistook the offer for a date.\n\n**Alex:** That sounds surprisingly romantic for check-in.\n\n**Receptionist:** I meant the snacks in your room's minibar, not a personal offer.\n\n**Alex:** Then I accept the snacks and decline to marry the minibar.\n\n${Array.from({length: 255}, (_,i) => `detail${i+1}`).join(' ')}\n\n## Italian Summary\n\nAlex chiarisce l'equivoco con una battuta.`;

test('format-only defects do not fail Writer content readiness', () => {
  const malformed = baseNarrative.replace('# Scene: Test\n\n','').replace('> Visual:','Visual:').replaceAll('**Alex:**','Alex:').replaceAll('**Receptionist:**','Receptionist:');
  assert.deepEqual(narrativeContentChecks(malformed), []);
  assert.ok(narrativePresentationChecks(malformed).length >= 2);
});

test('format-only Reviewer findings are removed and do not block content PASS', () => {
  const report = `REVIEW: REVISION REQUIRED\n\n### FORMAT — Labels\n\nNARRATIVE_EVIDENCE: "Alex: That sounds surprisingly romantic for check-in."\nProblem: speaker label lacks bold Markdown.`;
  const filtered = stripPresentationOnlyFindings(report, baseNarrative);
  assert.equal(filtered.autoPassed, true);
  assert.equal(filtered.removed, 1);
  assert.match(filtered.review, /^REVIEW: PASS/);
});

test('content check requires the receptionist to rule out a personal offer in dialogue', () => {
  const ambiguous = baseNarrative.replace('not a personal offer.', 'just the minibar.');
  assert.ok(narrativeContentChecks(ambiguous).some(issue => /personal\/romantic offer or invitation/.test(issue)));
  assert.ok(narrativeContentChecks(baseNarrative).every(issue => !/personal\/romantic offer or invitation/.test(issue)));
});

test('content check accepts Hemmingway natural minibar clarification with explicit non-romantic boundary', () => {
  const scene = baseNarrative.replace(
    '**Receptionist:** I meant the snacks in your room\'s minibar, not a personal offer.',
    '**Receptionist:** The complimentary drinks and snacks are in the minibar in your room. They are not a personal offer. They are not a romantic offer.'
  );
  assert.deepEqual(narrativeContentChecks(scene), []);
});

test('content check accepts a spoken minibar clarification phrased as an immediate correction', () => {
  const scene = baseNarrative.replace(
    'I meant the snacks in your room\'s minibar, not a personal offer.',
    'The minibar, actually. Drinks and snacks are included; it is not a personal compliment.'
  );
  assert.deepEqual(narrativeContentChecks(scene), []);
});

test('content check accepts an explicit no-romance statement without requiring a fixed phrase', () => {
  const scene = baseNarrative.replace(
    'I meant the snacks in your room\'s minibar, not a personal offer.',
    'That is the minibar in your room. The drinks are complimentary. No romantic connotations.'
  );
  assert.deepEqual(narrativeContentChecks(scene), []);
});

test('content check accepts a direct conversational statement that the receptionist is not making an offer', () => {
  const scene = baseNarrative.replace(
    'I meant the snacks in your room\'s minibar, not a personal offer.',
    'That is the minibar in your room. The drinks are complimentary. I am not making you an offer.'
  );
  assert.deepEqual(narrativeContentChecks(scene), []);
});

test('Reviewer evidence accepts a clearly Alex-attributed prose line while Codex handles its formatting', () => {
  const prose = `# Scene: Test\n\n## Narrative\n\nAlex looked back at her. "That means I'm sharing with the minibar, then."\n\n**Receptionist:** The minibar drinks are complimentary. They are not a personal offer.\n\n## Italian Summary\n\nTest.`;
  const review = `REVIEW: PASS\nMISUNDERSTANDING_EVIDENCE: "That means I'm sharing with the minibar, then."\nMINIBAR_CLARIFICATION_EVIDENCE: "The minibar drinks are complimentary. They are not a personal offer."\nCOMIC_RESPONSE_EVIDENCE: "That means I'm sharing with the minibar, then."`;
  assert.deepEqual(reviewPassEvidenceIssues(review, prose), []);
});

test('Reviewer clarification evidence can quote the non-romantic boundary when the minibar reference is a separate line', () => {
  const scene = baseNarrative.replace(
    '**Receptionist:** I meant the snacks in your room\'s minibar, not a personal offer.',
    '**Receptionist:** I mean the minibar in your room.\n\n**Receptionist:** This is not a personal offer.'
  );
  const review = `REVIEW: PASS\nMISUNDERSTANDING_EVIDENCE: "That sounds surprisingly romantic for check-in."\nMINIBAR_CLARIFICATION_EVIDENCE: "This is not a personal offer."\nCOMIC_RESPONSE_EVIDENCE: "Then I accept the snacks and decline to marry the minibar."`;
  assert.deepEqual(reviewPassEvidenceIssues(review, scene), []);
  assert.deepEqual(narrativeContentChecks(scene), []);
});

test('Image Controller fallback is concise and cannot leak Project File history into its prompt', () => {
  const plan = deterministicImagePlan('Warm brass lamps; Alex leans on the marble counter.');
  assert.equal(plan.generator, 'normal');
  assert.match(plan.prompt, /exactly two adult characters/i);
  assert.match(plan.prompt, /close medium two-person shot framed waist-up/i);
  assert.match(plan.prompt, /background completely empty/i);
  assert.doesNotMatch(plan.prompt, /Project File|Attempt [1-9]|Production History/i);
  assert.match(plan.negative_prompt, /background people/i);
  assert.match(plan.negative_prompt, /extra faces/i);
});

test('image generation defaults to landscape but accepts a safe job-specific square frame', () => {
  assert.deepEqual(imageDimensionsForJob({ job: {} }), { width: 1920, height: 1080 });
  assert.deepEqual(imageDimensionsForJob({ job: { imageSize: { width: 1024, height: 1024 } } }), { width: 1024, height: 1024 });
  assert.throws(() => imageDimensionsForJob({ job: { imageSize: { width: 100, height: 1024 } } }), /integers from 512 to 2048/);
});

test('Codex can repair formatting without using narrative edit budget but cannot rewrite the scene', () => {
  const formatted = baseNarrative.replace('**Alex:**','**Alex**:');
  assert.deepEqual(codexNarrativeEditBudgetIssues(baseNarrative, formatted), []);
  const rewritten = baseNarrative.replace(/The brass bell[\s\S]*?## Italian Summary/, 'A wholly different story begins with an unrelated mystery. '.repeat(30) + '\n\n## Italian Summary');
  assert.ok(codexNarrativeEditBudgetIssues(baseNarrative, rewritten).length);
});

test('Writer can expand an underlength draft while preserving it, but not replace the scene wholesale', () => {
  const short = `# Scene: Test\n\n## Narrative\n\n> Visual: Two adults at a hotel desk.\n\nThe brass bell sat between them. Alex studied the receptionist's smile and mistook the offer for a date.\n\n**Alex:** That sounds surprisingly romantic for check-in.\n\n**Receptionist:** I meant the snacks in your room's minibar, not a personal offer.\n\n**Alex:** Then I accept the snacks and decline to marry the minibar.\n\n## Italian Summary\n\nAlex chiarisce l'equivoco con una battuta.`;
  const expanded = short.replace('## Italian Summary', `${Array.from({length:120},(_,i)=>`preserved${i+1}`).join(' ')}\n\n## Italian Summary`);
  const replaced = short.replace(/The brass bell[\s\S]*?## Italian Summary/, `${'unrelated replacement '.repeat(160)}\n\n## Italian Summary`);
  assert.deepEqual(writerRevisionScopeChecks(short, expanded), []);
  assert.ok(writerRevisionScopeChecks(short, replaced).length);
});
