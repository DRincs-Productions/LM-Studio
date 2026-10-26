import test from 'node:test';
import { cleanCliText } from './cli-output.mjs';
import crypto from 'node:crypto';
import { LocalChatApi } from './production.mjs';
import { startRegiaRelay, talkToRegia, stopRegiaRelay, regiaRelayStatus, discardRegiaTurn, verifyCodexRelay } from './regia-relay.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, sha, waitHandback, alive } from './core.mjs';
import { discoverBinding, MemoryManager } from './bionic.mjs';
import { runJob } from './runner.mjs';
import { selectProgrammer, recordComponentTest } from './programmer.mjs';
import { attachProjectRoot, listNarrativeSources, readNarrativeSource } from './project-sources.mjs';
import { predictWithMcpTools } from './regia-tool-loop.mjs';
import { narrativeContentChecks, narrativePresentationChecks, reviewPassEvidenceIssues, deterministicImagePlan, writerInstruction, reviewerInstruction, compactNarrativeCanon, readLmStudioChatStream, visualMomentPrompts, requiredTimelineChecks, writerRevisionScopeChecks, singlePlaybackChecks, narrativeCanonBoundaryChecks, validateSceneContract, createSceneContract, sourceSpecifiesPov } from './production.mjs';

const handback = { summary: 'Prototype complete. Alex remains blonde and wears a black leather jacket.', completedTasks: ['Created prototype'], assets: [], problems: [], decisions: ['Choose a mission'], questionForUser: 'Which mission should Alex take?' };
async function fixture(t) {
  await fs.mkdir(path.resolve('work'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('work', 'bionic unit fixture '));
  const store = new Store(root);
  await fs.writeFile(store.project('project.md'), '# Canonical project\nAlex is blonde.\n');
  const state = await store.register('project.md');
  await store.update('project.md', s => { s.binding = { regiaSessionId: 'fixture-session', modelSpecifier: { type: 'indexed', indexedModelIdentifier: 'fixture-model' } }; });
  return { root, store, state: await store.read('project.md') };
}
async function enqueue(f) {
  const state = await f.store.read('project.md');
  return f.store.enqueue('project.md', { phase: 'prototype', summary: 'Create a prototype', expectedRevision: state.revision, expectedSha256: sha(await fs.readFile(f.store.project('project.md'), 'utf8')) });
}

test('two full persistent handoff/handback cycles and idempotent registration', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.register('project.md')).projectId, f.state.projectId);
  for (let i = 0; i < 2; i++) {
    const queued = await enqueue(f);
    const waiting = waitHandback(f.store, 'project.md', queued.job.id, { timeoutMs: 5000 });
    await runJob(f.store, 'project.md', { suspendRegia: true }, { verifyBinding: async b => b, memory: { suspend: async () => ({ status: 'unloaded' }) }, execute: async () => handback });
    assert.equal((await waiting).handback.summary, handback.summary);
    const state = await f.store.read('project.md'); assert.equal(state.owner, 'regia');
    await f.store.acknowledge('project.md', queued.job.id);
    await f.store.acknowledge('project.md', queued.job.id);
  }
  assert.equal((await f.store.read('project.md')).history.length, 2);
});
test('stale revision, hash conflict, duplicate start and path traversal are refused', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.project('../outside.md'));
  await assert.rejects(f.store.enqueue('project.md', { phase: 'x', summary: 'x', expectedRevision: -1, expectedSha256: 'wrong' }), /Stale/);
  await assert.rejects(f.store.enqueue('project.md', { phase: 'x', summary: 'x', expectedRevision: f.state.revision, expectedSha256: 'wrong' }), /changed/);
  await enqueue(f); await assert.rejects(enqueue(f), /not owned/);
});
test('cancelled MCP wait leaves job intact and later wait gets handback', async t => {
  const f = await fixture(t), state = await enqueue(f), controller = new AbortController(); controller.abort();
  assert.equal((await waitHandback(f.store, 'project.md', state.job.id, { signal: controller.signal })).status, 'wait_cancelled');
  assert.equal((await f.store.read('project.md')).status, 'queued');
  await f.store.finish('project.md', state.job.id, handback);
  assert.equal((await waitHandback(f.store, 'project.md', state.job.id)).status, 'handback_ready');
});
test('unavailable PC 2/dependency returns an error handback and never retries effects', async t => {
  const f = await fixture(t); await enqueue(f); let attempts = 0;
  const adapters = { verifyBinding: async b => b, execute: async () => { attempts++; throw Error('PC 2 unavailable'); } };
  await runJob(f.store, 'project.md', { suspendRegia: false }, adapters);
  await runJob(f.store, 'project.md', { suspendRegia: false }, adapters);
  const state = await f.store.read('project.md'); assert.equal(state.handback.status, 'error'); assert.equal(attempts, 1);
});
test('project updates are atomic, backed up and reject conflicting writes', async t => {
  const f = await fixture(t), old = await fs.readFile(f.store.project('project.md'), 'utf8');
  await f.store.replaceProject('project.md', '# Updated\nAlex remains blonde.\n', sha(old));
  await assert.rejects(f.store.replaceProject('project.md', 'Wrong', sha(old)), /Concurrent/);
  const files = await fs.readdir(path.join(f.store.stateRoot, 'project-backups')); assert.equal(files.length, 1);
});
test('memory manager refuses busy, queued, ambiguous or changing instances; unloads only selected idle model', async () => {
  const binding = { modelSpecifier: { indexedModelIdentifier: 'regia' } };
  const base = { indexedModelIdentifier: 'regia', identifier: 'instance-regia', status: 'idle', queued: 0 };
  for (const models of [[{ ...base, status: 'busy' }], [{ ...base, queued: 1 }], [base, base]]) {
    const m = new MemoryManager('fake', async () => ({ code: 0, stdout: JSON.stringify(models) }));
    await assert.rejects(m.suspend(binding));
  }
  const calls = []; let loaded = true;
  const m = new MemoryManager('fake', async (_, args) => { calls.push(args); if (args[0] === 'unload') loaded = false; return { code: 0, stdout: JSON.stringify(loaded ? [base, { ...base, indexedModelIdentifier: 'writer', identifier: 'writer' }] : []) }; });
  assert.equal((await m.suspend(binding)).status, 'unloaded');
  assert.deepEqual(calls.find(c => c[0] === 'unload'), ['unload', 'instance-regia']);
});
test('automatic association uses exact native tool result marker and fails on forks', async t => {
  const f = await fixture(t), dbPath = path.join(f.root, 'fixture.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, committed_head_entry_id TEXT, session_json TEXT); CREATE TABLE chat_entries (id TEXT, previous_id TEXT, entry_json TEXT, redirect_to_id TEXT);');
  db.prepare('INSERT INTO chat_entries VALUES (?, ?, ?, NULL)').run('request', null, JSON.stringify({ message: { role: 'assistant', parts: [{ type: 'toolCallRequest', name: 'register_project', uniqueToolCallId: 'call' }] } }));
  db.prepare('INSERT INTO chat_entries VALUES (?, ?, ?, NULL)').run('result', 'request', JSON.stringify({ message: { role: 'tool', parts: [{ type: 'toolCallResult', uniqueToolCallId: 'call', result: [{ type: 'text', text: 'BIONIC_BINDING_TOKEN: ' + f.state.bindingToken }] }] } }));
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('session-one', 'result', JSON.stringify({ modelSpecifier: { type: 'indexed', indexedModelIdentifier: 'regia' } }));
  const locations = [{ database: dbPath, bionicProjectId: 'project-one' }];
  const before = await fs.readFile(dbPath);
  assert.equal((await discoverBinding(f.state.bindingToken, locations)).regiaSessionId, 'session-one');
  assert.deepEqual(await fs.readFile(dbPath), before);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('session-fork', 'result', JSON.stringify({ modelSpecifier: { type: 'indexed', indexedModelIdentifier: 'regia' } }));
  await assert.rejects(discoverBinding(f.state.bindingToken, locations), /Ambiguous/); db.close();
});
test('dead runners return an interrupted handback without replaying production', async t => {
  const f = await fixture(t), queued = await enqueue(f);
  await f.store.update('project.md', s => { s.status = 'running'; s.job.runnerPid = 99999999; s.job.codexPid = 99999998; });
  const result = await waitHandback(f.store, 'project.md', queued.job.id, { timeoutMs: 2000 });
  assert.equal(result.handback.status, 'interrupted'); assert.equal((await f.store.read('project.md')).owner, 'regia');
});
test('Windows process liveness rejects a reused PID older state timestamp', () => {
  if (process.platform !== 'win32') return;
  assert.equal(alive(process.pid, '2000-01-01T00:00:00.000Z'), false);
  assert.equal(alive(process.pid, new Date(Date.now() + 60_000).toISOString()), true);
});
test('component test mode records a controlled MCP interaction without production side effects and rejects reused inputs', async t => {
  const f = await fixture(t);
  const first = await recordComponentTest({ store: f.store, run_id: 'component-run-0001', role: 'writer', input: 'Fresh test premise A', model: 'fixture-writer', response: 'Draft A', interaction: 'revision', mock_reply: 'Reviewer asks for a local change' });
  assert.match(first.content[0].text, /production_started": false/);
  await assert.rejects(recordComponentTest({ store: f.store, run_id: 'component-run-0001', role: 'writer', input: 'Fresh test premise A', model: 'fixture-writer', response: 'Draft B', interaction: 'revision', mock_reply: '' }), /used before/);
  const second = await recordComponentTest({ store: f.store, run_id: 'component-run-0001', role: 'writer', input: 'Fresh test premise B', model: 'fixture-writer', response: 'Revised draft', interaction: 'revision', mock_reply: 'Recorded' });
  assert.match(second.content[0].text, /component_test_recorded/);
});
test('Programmer provider selection is recorded but does not launch implementation', async t => {
  const f = await fixture(t), projectRoot = path.join(f.root, 'scratch-project');
  await fs.mkdir(projectRoot, { recursive: true });
  const oldRoots = process.env.BIONIC_PROGRAMMER_ROOTS;
  process.env.BIONIC_PROGRAMMER_ROOTS = f.root;
  try {
    const selected = await selectProgrammer({ store: f.store, filename: 'project.md', provider: 'codex', projectRoot });
    assert.match(selected.content[0].text, /awaiting_explicit_approval/);
    const state = JSON.parse(await fs.readFile(path.join(f.store.stateRoot, 'programmer', sha('project.md').toLowerCase() + '.json'), 'utf8'));
    assert.equal(state.status, 'awaiting_explicit_approval');
  } finally {
    if (oldRoots === undefined) delete process.env.BIONIC_PROGRAMMER_ROOTS;
    else process.env.BIONIC_PROGRAMMER_ROOTS = oldRoots;
  }
});
test('narrative checks accept fresh canon, flexible length and multiple visual moments', () => {
  const body = `# Scene: After the Last Broadcast\n\n## Narrative\n> Visual: Tali in the radio studio at midnight.\nTali and Ivo listen to the signal. ${'The night air carried a faint tune. '.repeat(90)}\n> Visual 2: The pair watch a flower open above the rooftop greenhouse.\nThe future message becomes an invitation.\n\n## Italian Summary\nA warm mystery about a radio signal.`;
  assert.deepEqual(narrativeContentChecks(body), []);
  assert.deepEqual(narrativePresentationChecks(body), []);
  assert.ok(narrativeContentChecks(body.replace('The future message becomes an invitation.', 'The future message becomes an invitation but')).some(issue => /truncated/i.test(issue)));
});
test('one-playback canon catches repeat listening and Ivo hearing the clip without rejecting a single playback', () => {
  const canon = 'There is exactly one recording and one playback. Ivo must never hear it.';
  assert.deepEqual(singlePlaybackChecks('At 3:14 the buffer plays the clip once while Tali watches the live clock.', canon), []);
  assert.deepEqual(singlePlaybackChecks('The message was not from the future.', canon), []);
  assert.ok(singlePlaybackChecks('The message came from the future.', canon).some(issue => /no future transmission/i.test(issue)));
  const issues = singlePlaybackChecks('At 3:14 Tali plays the clip once. Later, she replays it again for Ivo. He heard the message.', canon);
  assert.ok(issues.some(issue => /additional playback|repeat listening/i.test(issue)));
  assert.ok(issues.some(issue => /Ivo must not hear/i.test(issue)));
  assert.ok(singlePlaybackChecks('Ivo said, “I got your message.”', canon).some(issue => /must not receive/i.test(issue)));
  assert.ok(singlePlaybackChecks('He read the event log. It said something about an orchid and coffee.', canon).some(issue => /timing metadata only/i.test(issue)));
  assert.ok(singlePlaybackChecks('At 3:08 she records the memo, then listens to the playback once. At 3:14 the buffer plays it again.', canon).some(issue => /without previewing/i.test(issue)));
  assert.ok(singlePlaybackChecks('Ivo said, “I hear things all night. A memo playing back at 3:14 is going to make you look guilty.”', canon).some(issue => /only Tali hears/i.test(issue)));
  assert.ok(narrativeContentChecks('# Scene: Test\n\n## Narrative\nAt 3:14 Tali plays the clip once. Later, she replays it again for Ivo. He heard the message.\n\n## Italian Summary\nTest.', canon).length >= 2);
});
test('review evidence and fallback image prompt follow the current Project File instead of old test canon', () => {
  const narrative = 'The station hummed quietly while Tali held the receiver.';
  assert.deepEqual(reviewPassEvidenceIssues(`REVIEW: PASS\nNARRATIVE_EVIDENCE: "${narrative}"`, narrative), []);
  assert.deepEqual(reviewPassEvidenceIssues('REVIEW: PASS\nNARRATIVE_EVIDENCE: "the station hummed quietly while Tali held the receiver."', narrative), []);
  const quotedDialogue = '“It was worth it,” she said. “But I am docking you two minutes for the coffee.”';
  assert.deepEqual(reviewPassEvidenceIssues(`REVIEW: PASS\nNARRATIVE_EVIDENCE: "${quotedDialogue}"`, quotedDialogue), []);
  const evidencePrompt = reviewerInstruction('# Project\n', 'Approved scope', '# Scene: Test\n\n## Narrative\nThe station hummed quietly while Tali held the receiver.\n\n## Italian Summary\nA scene.', []);
  assert.match(evidencePrompt, /VERBATIM NARRATIVE EVIDENCE CANDIDATES/);
  assert.match(evidencePrompt, /- The station hummed quietly while Tali held the receiver\./);
  const canon = `# Project\n\n## Characters\n\n### Tali Rook\n- Dark hair and green jacket; botanist in the rooftop greenhouse.\n\n### Ivo Senn\n- Light-brown hair, steel-gray eyes, dark work shirt, headset around his neck.\n\n## Locations\n\n### Rooftop Greenhouse\n- Many plants and grow lights.\n\n### Radio Booth\n- Amber console lights, waveform monitor and patch cables.`;
  const plan = deterministicImagePlan('The radio booth at night. Show Ivo alone at the console.', canon);
  assert.match(plan.prompt, /Light-brown hair/);
  assert.match(plan.prompt, /Radio Booth/);
  assert.doesNotMatch(plan.prompt, /Rooftop Greenhouse|Many plants/);
  assert.ok(plan.prompt.length < 2500, 'fallback prompt must stay concise');
  assert.doesNotMatch(plan.prompt, /hotel reception|Alex|Receptionist|minibar/i);
  const instruction = writerInstruction('Canon: Tali and Ivo are adults.', 'Write the approved story.');
  assert.doesNotMatch(instruction, /250.?400|300.?330|minibar|Alex Rossi/i);
  assert.match(instruction, /Treat explicit chronology and relationship facts as hard constraints/);
  assert.match(instruction, /Do not invent unspecified character appearance, relationship history, plant species, technical mechanisms, or chronology details/);
  assert.match(reviewerInstruction('Canon.', 'Approved scope.', 'A scene.', []), /one sentence selected from the verbatim Narrative Evidence Candidates/);
});
test('image planner derives moments from distinct narrative sections when Visual directives are absent', () => {
  const narrative = `At 3:47 a.m., Ivo watched amber console lights flicker above the silent radio desk. He reached for the receiver as a strange voice broke through the static.\n\n---\n\nTali stood beneath the greenhouse grow lamps with a tea glass in one hand and a soil-stained glove in the other. Ivo appeared on the metal ladder, holding a printed signal trace.\n\n---\n\nAt dawn, they watched the orchid open inside its glass enclosure, dew catching the first light across the petals. Tali laughed as Ivo tried to explain the timing.`;
  const cues = visualMomentPrompts(narrative);
  assert.equal(cues.length, 3);
  assert.match(cues[0], /console lights/);
  assert.match(cues[1], /greenhouse grow lamps/);
  assert.match(cues[2], /orchid open/);
  const explicit = visualMomentPrompts('> Visual: A quiet booth under amber light.\n\n---\n\nAnother distinct passage.');
  assert.deepEqual(explicit, ['A quiet booth under amber light.']);
  assert.deepEqual(narrativePresentationChecks(`# Scene: No directives\n\n## Narrative\n${narrative}\n\n## Italian Summary\nA scene.`), []);
});
test('explicit Project File timelines are checked against the Narrative body, not its summary', () => {
  const canon = `#### REQUIRED STORY TIMELINE\n- 3:08 a.m.: Tali records the message without previewing it: “Ivo, come see the orchid at dawn.”\n- 3:14 a.m.: The buffer plays that exact message once: “Ivo, come see the orchid at dawn.”\n- 3:18 a.m.: The scheduler commits the metadata row with label_source=processed_at, four minutes after playback.\n- Dawn: The orchid opens.\n\n## Next Section\nOther content.`;
  const missing = `# Scene: Test\n\n## Narrative\nTali records the message at 3:08 a.m. and the scheduler shows 3:18 a.m.\n\n## Italian Summary\nAt 3:14 a.m. it plays.`;
  assert.equal(requiredTimelineChecks(missing, canon).length, 4);
  const wrongEvents = `# Scene: Test\n\n## Narrative\nThe buffer plays a clip at 3:08 a.m. Tali records “Ivo, come see the orchid at dawn” at 3:14 a.m. The scheduler logs 3:18 a.m. in error. At dawn the orchid opens.\n\n## Italian Summary\nComplete.`;
  assert.equal(requiredTimelineChecks(wrongEvents, canon).length, 3);
  const complete = `# Scene: Test\n\n## Narrative\nAt 3:08 a.m., Tali records “Ivo, come see the orchid at dawn.” without previewing it. At 3:14 a.m., the buffer plays that exact message once: “Ivo, come see the orchid at dawn.” At 3:18 a.m., the scheduler commits the metadata log row with label_source=processed_at, four minutes after playback. At dawn the orchid opens.\n\n## Italian Summary\nComplete.`;
  assert.deepEqual(requiredTimelineChecks(complete, canon), []);
  const eventBeforeClock = `# Scene: Test\n\n## Narrative\nAt 3:08 a.m., Tali records “Ivo, come see the orchid at dawn.” without previewing it. Six minutes later the speaker crackles. “Ivo, come see the orchid at dawn.” The buffer plays her exact words once. Tali checks the display: 3:14 a.m. At 3:18 a.m., four minutes after the 3:14 playback, the scheduler commits the metadata row with label_source=processed_at. At dawn Tali and Ivo watch the orchid open.\n\n## Italian Summary\nComplete.`;
  assert.deepEqual(requiredTimelineChecks(eventBeforeClock, canon), []);
  const twentyFourHourClock = `# Scene: Test\n\n## Narrative\n03:08 Tali records “Ivo, come see the orchid at dawn.” without previewing it. At 03:14 the buffer plays that exact message once: “Ivo, come see the orchid at dawn.” At 03:18 the scheduler commits the metadata log row with label_source=processed_at, four minutes after playback. At dawn Tali and Ivo watch the orchid open.\n\n## Italian Summary\nComplete.`;
  assert.deepEqual(requiredTimelineChecks(twentyFourHourClock, canon), []);
});
test('required dawn opening is shown on-page and shared by both leads when canon says so', () => {
  const canon = '#### REQUIRED STORY TIMELINE\n- Dawn: Tali and Ivo share the actual orchid opening; show the petals opening.';
  const missing = '# Scene: Test\n\n## Narrative\nTali and Ivo promise to return at dawn.\n\n## Italian Summary\nThe orchid opens.';
  assert.ok(requiredTimelineChecks(missing, canon).some(issue => /actual dawn opening/i.test(issue)));
  const notShared = '# Scene: Test\n\n## Narrative\nThe orchid opens at dawn while the greenhouse is empty.\n\n## Italian Summary\nComplete.';
  assert.ok(requiredTimelineChecks(notShared, canon).some(issue => /share the flower opening/i.test(issue)));
  const complete = '# Scene: Test\n\n## Narrative\nAt dawn Tali and Ivo stay beside the orchid. Its petals open in the first light, and they watch together.\n\n## Italian Summary\nComplete.';
  assert.deepEqual(requiredTimelineChecks(complete, canon), []);
});
test('first encounter stays on the pathway and orchid history is not invented', () => {
  const canon = 'The first personal conversation is on the rooftop access pathway. This is an unidentified rare orchid; do not invent its growth history or prior bloom history.';
  assert.ok(narrativeCanonBoundaryChecks('Ivo arrives while Tali is inside the greenhouse and they meet beside the desk.', canon).some(issue => /rooftop access pathway/i.test(issue)));
  assert.equal(narrativeCanonBoundaryChecks('At 3:18, on the rooftop access pathway, Tali and Ivo meet and begin speaking for the first time.', canon).length, 0);
  assert.ok(narrativeCanonBoundaryChecks('At 3:18, on the rooftop access pathway, Tali and Ivo meet for the first time. No one had ever seen the orchid bloom.', canon).some(issue => /prior bloom history/i.test(issue)));
  assert.ok(narrativeCanonBoundaryChecks('He steps out onto the access pathway. “First time we have met,” he says.', canon).length === 0);
  assert.ok(narrativeCanonBoundaryChecks('The orchid has been closed since I started keeping it alive.', canon).some(issue => /prior bloom history/i.test(issue)));
});
test('narrative prompts keep relevant canon below the model context budget', () => {
  const canon = `# Project\n\n## Task Objective\nA warm mystery in a radio station above a rooftop greenhouse.\n\n## Character Profiles\n### Ivo Senn\nLight-brown hair, steel-gray eyes, dark work shirt; thoughtful overnight radio engineer.\n### Tali Rook\nDark hair, hazel eyes, green utility jacket; witty botanist.\n\n## Location Definitions\n### Radio Booth\nAmber console lights, waveform monitors and patch cables.\n### Rooftop Greenhouse\nGrow lights, rare flowers and wet soil.\n\n## Handoff Status\n${'Stale status and unrelated process notes. '.repeat(120)}`;
  const compact = compactNarrativeCanon(canon);
  assert.ok(compact.length < canon.length / 2);
  assert.match(compact, /Ivo Senn/);
  assert.match(compact, /Tali Rook/);
  assert.match(compact, /Radio Booth/);
  assert.doesNotMatch(compact, /Stale status/);
  const prompt = writerInstruction(canon, 'Write a complete scene.');
  assert.ok(prompt.length < 9000);
  const longStory = `## Story Direction\n${'Old alternatives and background. '.repeat(500)}\n### Complete-Test Canon Clarification\nThis overrides the old story.\n#### REQUIRED STORY TIMELINE\nRecorded at 3:08, played at 3:14; the inaccurate scheduler shows 3:18. This is their first meeting.\n## Other Section\n${'Unrelated. '.repeat(100)}`;
  const targeted = compactNarrativeCanon(longStory, 400);
  assert.match(targeted, /3:08, played at 3:14/);
  assert.match(targeted, /first meeting/);
  assert.doesNotMatch(targeted, /Old alternatives/);
  assert.match(writerInstruction(longStory, 'Follow the approved timeline.'), /Complete-Test Canon Clarification.*overrides any older conflicting/i);
  assert.deepEqual(writerRevisionScopeChecks('A '.repeat(400) + 'ending.', 'A '.repeat(300) + 'B '.repeat(100) + 'ending.'), []);
});

test('SceneContract enforces mode, preserves unknown POV and requires a bounded typed schema', () => {
  const contract = {
    scene_id: 'scene-test', mode: 'normal', pov: null, location: 'unspecified', participants: ['Mara'],
    canon_facts: ['Mara is closing the shop.'], known_by_character: { Mara: ['She is closing the shop.'] },
    unknowns: ['The shop address is unspecified.'], required_beats: ['Mara closes the shop.'],
    forbidden_changes: ['Do not add another named character.'], closing_condition: 'End when Mara closes the door.',
    creative_permissions: { sensory_details: true, minor_gestures: true, dialogue_within_known_facts: true, new_plot_events: false }
  };
  assert.deepEqual(validateSceneContract(contract, 'scene-test'), []);
  assert.ok(validateSceneContract({ ...contract, mode: 'adult and dark' }, 'scene-test').some(issue => /mode must be normal, adult, or dark/.test(issue)));
  assert.ok(validateSceneContract({ ...contract, pov: 'third_person' }, 'scene-test', 'Mara is closing the shop.').some(issue => /must leave pov null/.test(issue)));
  assert.deepEqual(validateSceneContract({ ...contract, pov: 'third_person' }, 'scene-test', 'Use third-person POV.'), []);
  assert.equal(sourceSpecifiesPov('The narrator uses third-person point of view.'), true);
  assert.equal(sourceSpecifiesPov('The scene is set in a repair shop.'), false);
  assert.ok(validateSceneContract({ ...contract, scene_id: 'other' }, 'scene-test').some(issue => /scene_id/.test(issue)));
  assert.ok(validateSceneContract({ ...contract, creative_permissions: { ...contract.creative_permissions, new_plot_events: 'maybe' } }, 'scene-test').some(issue => /creative_permissions/.test(issue)));
  assert.ok(validateSceneContract({ ...contract, unexpected: true }, 'scene-test').some(issue => /exactly match/.test(issue)));
});

test('SceneContract runs Codex and Qwen proposals in parallel, then validates Codex merge before Writer', async t => {
  const root = await fs.mkdtemp(path.resolve('work', 'scene contract fixture '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = {
    scene_id: 'scene-contract-test', mode: 'normal', pov: null, location: 'repair shop', participants: ['Mara'],
    canon_facts: ['Mara carries a key in her left hand.'], known_by_character: { Mara: ['She carries the key.'] },
    unknowns: ['The shop address is unspecified.'], required_beats: ['Mara places the key on the counter at the end.'],
    forbidden_changes: ['Do not add named characters.'], closing_condition: 'End immediately after the key is placed.',
    creative_permissions: { sensory_details: true, minor_gestures: true, dialogue_within_known_facts: true, new_plot_events: false }
  };
  let codexProposalStarted = false, qwenProposalStarted = false, mergeStarted = false;
  const codexPlanner = async (prompt, outputPath) => {
    if (prompt.includes('QWEN INDEPENDENT PROPOSAL')) {
      mergeStarted = true;
      assert.equal(codexProposalStarted, true);
      assert.equal(qwenProposalStarted, true);
      await fs.writeFile(outputPath, JSON.stringify(base));
      return JSON.stringify(base);
    }
    codexProposalStarted = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.writeFile(outputPath, JSON.stringify(base));
    return JSON.stringify(base);
  };
  const predict = async (role, prompt, options) => {
    assert.equal(role, 'planner');
    assert.equal(options.systemPromptOverride.includes('SceneContract'), true);
    qwenProposalStarted = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    return JSON.stringify(base);
  };
  const result = await createSceneContract({
    sceneId: base.scene_id, canonical: '# Canon\nMara carries a key in her left hand.', summary: 'Mara closes the repair shop.',
    out: root, predict, codexPlanner
  });
  assert.equal(mergeStarted, true);
  assert.deepEqual(result.contract, base);
  assert.equal((await fs.readFile(result.path, 'utf8')).includes('"mode": "normal"'), true);
  assert.equal(result.sha256.length, 64);
  assert.equal(await fs.stat(path.join(root, 'scene-contract-codex-proposal.json')).then(s => s.isFile()), true);
  assert.equal(await fs.stat(path.join(root, 'scene-contract-qwen-proposal.json')).then(s => s.isFile()), true);
});

test('Writer and Narrative Reviewer receive the SceneContract as advisory, below Project File and approved brief', () => {
  const contract = { scene_id: 'fixture', mode: 'normal', pov: null, required_beats: ['Show the handoff.'] };
  const writer = writerInstruction('# Canon\nMara is 32.', 'Show the handoff.', '', '', contract);
  const reviewer = reviewerInstruction('# Canon\nMara is 32.', 'Show the handoff.', '# Scene: Test\n\n## Narrative\nMara hands over the parcel.\n\n## Italian Summary\nConsegna il pacco.', [], contract);
  assert.match(writer, /APPROVED SCENE CONTRACT/);
  assert.match(writer, /does not override the Project File or approved brief/);
  assert.match(reviewer, /canonical Project File and approved scope take precedence/);
  assert.match(reviewer, /Show the handoff/);
});
test('LM Studio SSE chat parser waits for and returns the final aggregated chat.end result', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: chat.start\ndata: {"type":"chat.start"}\n\n',
    'event: message.delta\ndata: {"type":"message.delta","content":"hello"}\n\n',
    'event: chat.end\ndata: {"type":"chat.end","result":{"model_instance_id":"writer-1","output":[{"type":"message","content":"hello world"}],"stats":{"total_output_tokens":2}}}\n\n'
  ];
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
  const result = await readLmStudioChatStream(stream);
  assert.equal(result.model_instance_id, 'writer-1');
  assert.equal(result.output[0].content, 'hello world');
  assert.equal(result.stats.total_output_tokens, 2);
});

test('CLI loading progress does not pollute a narrative or overflow the MCP response limit', () => {
  const artifact = '# Scene: Harbor\n\n## Narrative\n\nShe held the parcel.\n\n## Italian Summary\n\nTiene il pacco.';
  const progress = '\u001b[2KLoading model 81% ⠙\r\nLoading model 81% ⠹\r\n'.repeat(1000);
  assert.ok(progress.length > 30000);
  assert.equal(cleanCliText(progress + artifact), artifact);
  assert.equal(cleanCliText('<think>internal</think>\n' + artifact), artifact);
});

test('Codex Regia relay persists messages, proposals and idempotent replies across restart and suspension', async t => {
  const f = await fixture(t);
  const session = await startRegiaRelay(f.store, 'project.md');
  const args = {filename:'project.md',sessionId:session.session_id,requestId:crypto.randomUUID(),message:'Una biblioteca su una nave.'};
  let calls=0;
  const adapters={predict:async prompt=>{
    calls++;
    assert.equal(JSON.parse(prompt).user_message,args.message);
    return {text:JSON.stringify({reply:'Che cosa custodisce la biblioteca?',project_document:'# Canonical project\nAlex is blonde.\nProposed ship library.'})};
  }};
  const response=await talkToRegia(f.store,args,adapters);
  assert.equal(response.document_saved,false);
  assert.doesNotMatch(await fs.readFile(f.store.project('project.md'),'utf8'),/ship library/);
  const restarted=new Store(f.root);
  assert.deepEqual(await talkToRegia(restarted,args,adapters),response);
  assert.equal(calls,1);
  await assert.rejects(talkToRegia(restarted,{...args,message:'Different'},adapters),/different message/);
  await stopRegiaRelay(restarted,'project.md',session.session_id);
  await assert.rejects(talkToRegia(restarted,{...args,requestId:crypto.randomUUID()},adapters),/suspended/);
  assert.equal((await startRegiaRelay(restarted,'project.md')).session_id,session.session_id);
  await talkToRegia(restarted,{...args,requestId:crypto.randomUUID(),message:'Una mappa delle maree.'},{predict:async prompt=>{
    assert.equal(JSON.parse(prompt).history[0].regia,response.reply);
    return {text:JSON.stringify({reply:'La mappa resta una proposta.',project_document:null})};
  }});
  assert.equal((await regiaRelayStatus(restarted,'project.md')).turns,2);
  assert.notEqual((await startRegiaRelay(restarted,'project.md',{newSession:true})).session_id,session.session_id);
  await assert.rejects(talkToRegia(restarted,{...args,requestId:crypto.randomUUID()},adapters),/Stale/);
});

test('failed Regia envelope is retained and never replayed without explicit discard', async t => {
  const f=await fixture(t), session=await startRegiaRelay(f.store,'project.md');
  const args={filename:'project.md',sessionId:session.session_id,requestId:crypto.randomUUID(),message:'Nuova idea'};
  let calls=0;
  const adapters={predict:async()=>{calls++;return {text:'{invalid JSON'};}};
  await assert.rejects(talkToRegia(f.store,args,adapters));
  assert.equal((await regiaRelayStatus(f.store,'project.md')).pending.raw.text,'{invalid JSON');
  await assert.rejects(talkToRegia(f.store,args,adapters),/unresolved/);
  assert.equal(calls,1);
  await assert.rejects(verifyCodexRelay(f.store,await f.store.read('project.md')),/pending/);
  await discardRegiaTurn(f.store,'project.md',session.session_id,args.requestId);
  assert.equal((await regiaRelayStatus(f.store,'project.md')).pending,null);
});

test('Codex handoff verifies relay independently while default Bionic binding gate remains', async t => {
  const f=await fixture(t);
  await f.store.update('project.md',s=>{s.binding=null;});
  const enqueue=async frontend=>{
    const state=await f.store.read('project.md');
    return f.store.enqueue('project.md',{phase:'relay-fixture',summary:'Fixture only',frontend,expectedRevision:state.revision,expectedSha256:sha(await fs.readFile(f.store.project('project.md'),'utf8'))});
  };
  await assert.rejects(enqueue('codex'),/association/);
  const relay=await startRegiaRelay(f.store,'project.md');
  await assert.rejects(enqueue('bionic'),/association/);
  await enqueue('codex');
  let executed=0;
  await runJob(f.store,'project.md',{suspendRegia:false},{verifyBinding:async()=>{throw Error('Must not consult Bionic');},execute:async()=>{executed++;return handback;}});
  const state=await f.store.read('project.md');
  assert.equal(executed,1);
  assert.equal(state.handback.status,'completed');
  assert.equal(state.job.relaySessionId,relay.session_id);
  await f.store.acknowledge('project.md',state.job.id);
  await fs.unlink(path.join(f.store.stateRoot,'regia-relay',relay.session_id+'.json'));
  await assert.rejects(verifyCodexRelay(f.store,await f.store.read('project.md')));
});

test('Regia prose is relayed verbatim and project edits remain hash-guarded', async t => {
  const f=await fixture(t), session=await startRegiaRelay(f.store,'project.md');
  const args={filename:'project.md',sessionId:session.session_id,requestId:crypto.randomUUID(),message:'Un segreto personale.'};
  const prose='**Regia**\nPreferisci una promessa dimenticata oppure una lettera mai spedita?';
  const response=await talkToRegia(f.store,args,{predict:async()=>({text:prose})});
  assert.equal(response.reply,prose);
  assert.equal(response.proposed_project_document,null);
  assert.equal(response.production_started,false);
  await f.store.replaceProject('project.md','# New canonical facts\n',response.expected_sha256);
  await assert.rejects(f.store.replaceProject('project.md','Stale proposal',response.expected_sha256),/Concurrent/);
  await talkToRegia(f.store,{...args,requestId:crypto.randomUUID(),message:'Continuiamo.'},{predict:async prompt=>{
    assert.match(JSON.parse(prompt).canonical_project_file,/New canonical facts/);
    return {text:'Quale fatto vuoi approfondire?'};
  }});
});

test('Regia can request larger local context while production defaults remain unchanged', async () => {
  const originalFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async (_url,options)=>{
    requests.push(JSON.parse(options.body));
    return new Response('event: chat.end\ndata: '+JSON.stringify({result:{model_instance_id:'fixture-model',output:[{type:'message',content:'Reply'}],stats:{}}})+'\n\n');
  };
  const api=new LocalChatApi(); api.started=true;
  try {
    await api.predict('fixture-model','A','B',{},'writer');
    await api.predict('fixture-model','A','B',{},'regia',{contextLength:32768});
    assert.deepEqual(requests.map(item=>item.context_length),[8192,32768]);
    await assert.rejects(api.predict('fixture-model','A','B',{},'regia',{contextLength:-1}),/context/);
  } finally {globalThis.fetch=originalFetch;}
});

test('Regia project-source tools list and read only Ink and docs Markdown without modifying sources', async t => {
  const f = await fixture(t);
  const projectRoot = path.join(f.root, 'game');
  await fs.mkdir(path.join(projectRoot, 'docs', 'characters'), { recursive: true });
  const inkPath = path.join(projectRoot, 'ink', 'start.ink');
  const docPath = path.join(projectRoot, 'docs', 'characters', 'new-character.md');
  const hiddenPath = path.join(projectRoot, 'package.json');
  await fs.mkdir(path.dirname(inkPath), { recursive: true });
  await fs.writeFile(inkPath, '=== start ===\nA station light flickers.\n-> END\n');
  await fs.writeFile(docPath, '# New character\nAdult archivist; speaks in concise, dry sentences.\n');
  await fs.writeFile(hiddenPath, '{"private":true}\n');
  const originalRoot = process.env.BIONIC_PROGRAMMER_ROOTS;
  process.env.BIONIC_PROGRAMMER_ROOTS = f.root;
  try {
    const state = await attachProjectRoot(f.store, 'project.md', projectRoot);
    assert.equal(state.projectRoot, await fs.realpath(projectRoot));
  } finally {
    if (originalRoot === undefined) delete process.env.BIONIC_PROGRAMMER_ROOTS;
    else process.env.BIONIC_PROGRAMMER_ROOTS = originalRoot;
  }
  const inventory = await listNarrativeSources(f.store, 'project.md');
  assert.deepEqual(inventory.files.map(file => file.path).sort(), ['docs/characters/new-character.md', 'ink/start.ink']);
  assert.ok(inventory.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  const read = await readNarrativeSource(f.store, 'project.md', 'docs/characters/new-character.md');
  assert.match(read.content, /concise, dry sentences/);
  assert.equal(read.sha256, sha(read.content));
  await assert.rejects(readNarrativeSource(f.store, 'project.md', '../project.md'), /Invalid project-relative/);
  await assert.rejects(readNarrativeSource(f.store, 'project.md', 'package.json'), /Only Ink files/);
  assert.equal(await fs.readFile(inkPath, 'utf8'), '=== start ===\nA station light flickers.\n-> END\n');
  assert.equal(await fs.readFile(hiddenPath, 'utf8'), '{"private":true}\n');
});

test('Regia project-source reader rejects linked files that resolve outside the selected root', async t => {
  const f = await fixture(t);
  const projectRoot = path.join(f.root, 'game');
  const docs = path.join(projectRoot, 'docs');
  const outside = path.join(f.root, 'outside.md');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(outside, '# Outside project\n');
  const originalRoot = process.env.BIONIC_PROGRAMMER_ROOTS;
  process.env.BIONIC_PROGRAMMER_ROOTS = f.root;
  try { await attachProjectRoot(f.store, 'project.md', projectRoot); }
  finally {
    if (originalRoot === undefined) delete process.env.BIONIC_PROGRAMMER_ROOTS;
    else process.env.BIONIC_PROGRAMMER_ROOTS = originalRoot;
  }
  const link = path.join(docs, 'external.md');
  try { await fs.symlink(outside, link, 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    t.skip('This Windows account cannot create symbolic links');
    return;
  }
  await assert.rejects(readNarrativeSource(f.store, 'project.md', 'docs/external.md'), /resolves outside|Linked sources/);
  const inventory = await listNarrativeSources(f.store, 'project.md');
  assert.equal(inventory.files.length, 0);
});

test('Regia can associate only a project directory inside configured Programmer roots', async t => {
  const f = await fixture(t);
  const approved = path.join(f.root, 'approved');
  const rejected = path.join(f.root, 'rejected');
  await fs.mkdir(approved, { recursive: true });
  await fs.mkdir(rejected, { recursive: true });
  const originalRoot = process.env.BIONIC_PROGRAMMER_ROOTS;
  process.env.BIONIC_PROGRAMMER_ROOTS = approved;
  try {
    const attached = await attachProjectRoot(f.store, 'project.md', approved);
    assert.equal(attached.projectRoot, await fs.realpath(approved));
    await assert.rejects(attachProjectRoot(f.store, 'project.md', rejected), /outside configured Programmer roots/);
  } finally {
    if (originalRoot === undefined) delete process.env.BIONIC_PROGRAMMER_ROOTS;
    else process.env.BIONIC_PROGRAMMER_ROOTS = originalRoot;
  }
});

test('Regia tool-call loop permits only the read-only source tools and returns final prose', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'list_narrative_sources', arguments: '{"filename":"project.md"}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'Ho letto il progetto. Quale tono preferisci?', tool_calls: [] } }] }
  ];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let calls = 0;
  try {
    const result = await predictWithMcpTools({
      model: 'regia-fixture', system: 'system', prompt: 'user',
      tools: [{ name: 'list_narrative_sources', description: 'List files', inputSchema: { type: 'object', properties: {} } }],
      callTool: async name => { calls++; assert.equal(name, 'list_narrative_sources'); return { content: [{ type: 'text', text: '{"files":[]}' }] }; }
    });
    assert.equal(result.text, 'Ho letto il progetto. Quale tono preferisci?');
    assert.equal(result.toolCalls, 1);
    assert.equal(calls, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tool_choice, 'auto');
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'tool-1'));
  } finally { globalThis.fetch = originalFetch; }
  await assert.rejects(predictWithMcpTools({ model: 'x', system: 's', prompt: 'p', tools: [{ name: 'update_project_file' }], callTool: async () => ({}) }), /read-only narrative-source/);
});
