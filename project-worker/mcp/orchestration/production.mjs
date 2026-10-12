import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, sha } from './core.mjs';
import { run, MemoryManager } from './bionic.mjs';

const lmRoot = process.env.BIONIC_LM_ROOT || path.join(process.env.USERPROFILE, '.lmstudio');
const productionRoot = path.join(lmRoot, 'production');
const lms = path.join(process.env.USERPROFILE, '.lmstudio', 'bin', 'lms.exe');
const specs = {
  writer: { match: /writer.*27b|27b.*writer/i, gpu: '0.85' },
  reviewer: { match: /narrative reviewer/i, gpu: 'max' },
  imageController: { match: /image controller/i, gpu: 'max' }
};
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
export class LocalChatApi {
  constructor(lms = path.join(process.env.USERPROFILE, '.lmstudio', 'bin', 'lms.exe'), runner = run) { this.lms = lms; this.runner = runner; this.owned = false; this.started = false; }
  async ensure() {
    if (this.started) return;
    const status = await this.runner(this.lms, ['server', 'status']);
    const message = (status.stdout || '') + (status.stderr || '');
    if (/server is running on port 1234/i.test(message)) { this.started = true; return; }
    if (!/server is not running/i.test(message)) throw Error('Cannot determine local LM Studio server state');
    const started = await this.runner(this.lms, ['server', 'start'], { timeoutMs: 30000 });
    if (started.code !== 0 || !/server is now running on port 1234/i.test(started.stdout + started.stderr)) throw Error('Could not start the local LM Studio API server');
    this.started = true; this.owned = true;
  }
  async predict(modelInstanceId, prompt, system, config, role) {
    await this.ensure();
    const fields = Object.fromEntries((config.operation?.fields || []).map(field => [field.key, field.value]));
    const repeat = fields['llm.prediction.repeatPenalty'];
    const thinking = fields['llm.prediction.reasoning.enableThinking'];
    const body = {
      model: modelInstanceId,
      input: prompt.replace(/\/no_think/g, ''),
      system_prompt: system,
      temperature: fields['llm.prediction.temperature'] ?? (role === 'writer' ? 0.75 : 0.6),
      repeat_penalty: repeat && typeof repeat === 'object' ? (repeat.checked ? repeat.value : false) : (repeat ?? 1.05),
      max_output_tokens: fields['llm.prediction.maxPredictedTokens'] ?? fields['llm.prediction.maxTokens'] ?? 3072,
      context_length: 8192,
      store: false
    };
    if (typeof thinking === 'boolean') body.reasoning = thinking ? 'on' : 'off';
    const response = await fetch('http://127.0.0.1:1234/api/v1/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000)
    });
    const result = await response.json();
    if (!response.ok) throw Error(`LM Studio local chat API returned HTTP ${response.status}: ${JSON.stringify(result).slice(0, 600)}`);
    if (result.model_instance_id && result.model_instance_id !== modelInstanceId) throw Error('LM Studio responded from an unexpected model instance');
    const text = result.output?.filter(output => output.type === 'message').map(output => output.content).join('\n') || '';
    if (!text.trim()) throw Error('LM Studio local chat API returned no message text');
    return { text: clean(text), stats: result.stats || null, responseIdStored: Boolean(result.response_id) };
  }
  async stopIfOwned() {
    if (!this.owned) return;
    const stopped = await this.runner(this.lms, ['server', 'stop'], { timeoutMs: 30000 });
    if (stopped.code !== 0) throw Error('Could not stop the LM Studio API server started by this job');
    this.owned = false; this.started = false;
  }
}
export function reviewVerdict(text) {
  const matches = clean(text).match(/^REVIEW:\s*(PASS|REVISION REQUIRED)\s*$/gm) || [];
  if (matches.length !== 1) throw Error('Reviewer must return one unambiguous verdict');
  return /REVISION REQUIRED/.test(matches[0]) ? 'REVISION REQUIRED' : 'PASS';
}
export function reviewPassEvidenceIssues(review, narrative) {
  const fields = [
    ['MISUNDERSTANDING_EVIDENCE', 'misunderstanding'],
    ['MINIBAR_CLARIFICATION_EVIDENCE', 'clarification'],
    ['COMIC_RESPONSE_EVIDENCE', 'comic response']
  ];
  const issues = [];
  const quoted = {};
  for (const [key, label] of fields) {
    const match = review.match(new RegExp(`^${key}:\\s*["“]([^"”]+)["”]\\s*$`, 'm'));
    if (!match) { issues.push(`Reviewer PASS missing ${label} verbatim evidence quote`); continue; }
    quoted[key] = match[1];
    if (!narrative.includes(match[1])) issues.push(`Reviewer ${label} quote does not occur verbatim in the Narrative`);
  }
  // The clarification may be split across adjacent Receptionist lines: one names the minibar and another rules out romantic intent. The content precheck validates both parts independently.
  if (quoted.COMIC_RESPONSE_EVIDENCE) {
    const explicitlyLabeled = narrative.split(/\r?\n/).some(line => /^\*\*Alex:\*\*/.test(line) && line.includes(quoted.COMIC_RESPONSE_EVIDENCE));
    const quoteAt = narrative.indexOf(quoted.COMIC_RESPONSE_EVIDENCE);
    const start = narrative.lastIndexOf('\n\n', quoteAt) + 2;
    const end = narrative.indexOf('\n\n', quoteAt);
    const paragraph = narrative.slice(start, end < 0 ? undefined : end);
    const beforeQuote = paragraph.slice(0, paragraph.indexOf(quoted.COMIC_RESPONSE_EVIDENCE));
    const namedSpeakers = [...beforeQuote.matchAll(/\b(Alex|Receptionist)\b/gi)].map(match => match[1].toLowerCase());
    const proseAttributedToAlex = namedSpeakers.at(-1) === 'alex' && !/\bReceptionist\b/i.test(paragraph);
    if (!explicitlyLabeled && !proseAttributedToAlex) issues.push('Reviewer comic-response quote is not clearly attributable to Alex; use an Alex dialogue line or nearby Alex attribution');
  }
  return issues;
}
export function reviewFindingEvidenceIssues(review, narrative, mechanicalChecks = []) {
  const findings = review.split(/(?=^###\s)/m).filter(block => /^###\s/.test(block));
  if (!findings.length) return ['Reviewer revision report contains no structured findings with source evidence'];
  const issues = [];
  findings.forEach((finding, index) => {
    const match = finding.match(/^NARRATIVE_EVIDENCE:\s*["“]([^"”]+)["”]\s*$/m);
    if (match) {
      if (!narrative.includes(match[1])) issues.push(`Reviewer finding ${index + 1} quotes text absent from the Narrative`);
      return;
    }
    const quotedText = [...finding.matchAll(/["“]([^"”]+)["”]/g)].map(item => item[1]);
    if (quotedText.some(quote => narrative.includes(quote))) return;
    const text = finding.toLowerCase().replace(/[_-]+/g, ' ');
    const objectivelySupported = mechanicalChecks.some(check => {
      const issue = check.toLowerCase();
      if (/word\s*count|length/.test(text)) return /word count/.test(issue);
      if (/speaker label|acting direction|parenthetical/.test(text)) return /acting directions/.test(issue);
      if (/minibar|clarification|personal offer/.test(text)) return /explicitly clarify/.test(issue);
      if (/repeat|unchanged draft/.test(text)) return /repeated the rejected draft/.test(issue);
      if (/visual directive|choice|format|heading/.test(text)) return /missing|remove|choices|visual directive|section/.test(issue);
      return false;
    });
    if (!objectivelySupported) issues.push(`Reviewer finding ${index + 1} has no matching verbatim quotation or mechanical check`);
  });
  return issues;
}
export function stripPresentationOnlyFindings(review, narrative) {
  const blocks = review.split(/(?=^###\s)/m);
  const intro = blocks.shift() || '';
  const findings = blocks.filter(block => /^###\s/.test(block));
  const substantive = findings.filter(block => {
    const header = block.split(/\r?\n/, 1)[0];
    const body = block.slice(header.length);
    const presentationOnly = /\bFORMAT\b/i.test(header)
      && !/\b(?:plot|story|beat|character|motivation|misunderstanding|clarification|continuity|canon|missing event|incomplete scene|unclear intent)\b/i.test(body);
    return !presentationOnly;
  });
  const removed = findings.length - substantive.length;
  if (!removed) return { review, removed, autoPassed: false };
  if (substantive.length) return { review: `${intro.replace(/^REVIEW:\s*REVISION REQUIRED/m, 'REVIEW: REVISION REQUIRED').trim()}\n\n${substantive.join('\n')}`, removed, autoPassed: false };
  const body = narrative.split(/## Italian Summary/i)[0];
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const dialogue = lines.map((line, index) => {
    const match = line.match(/^(?:\*\*)?(Alex|Receptionist)(?:\*\*)?:\*{0,2}\s*(.+)$/);
    return match ? { speaker: match[1], text: match[2], line, index } : null;
  }).filter(Boolean);
  const clarify = dialogue.findIndex(item => item.speaker === 'Receptionist' && /\b(?:minibar|drinks?|snacks?|room)\b/i.test(item.text) && /\b(?:mean|meant|talking about|referring to|just|only)\b/i.test(item.text));
  const misunderstanding = clarify >= 0 ? dialogue.slice(0, clarify).reverse().find(item => item.speaker === 'Alex') : null;
  const comic = clarify >= 0 ? dialogue.slice(clarify + 1).find(item => item.speaker === 'Alex') : null;
  if (!misunderstanding || clarify < 0 || !comic || [misunderstanding, dialogue[clarify], comic].some(item => item.text.includes('"'))) {
    return { review: `${intro.trim()}\n\nThe only structured findings were presentation issues, but the required content evidence could not be safely extracted.`, removed, autoPassed: false };
  }
  return {
    review: `REVIEW: PASS\nMISUNDERSTANDING_EVIDENCE: "${misunderstanding.text}"\nMINIBAR_CLARIFICATION_EVIDENCE: "${dialogue[clarify].text}"\nCOMIC_RESPONSE_EVIDENCE: "${comic.text}"\n\nLe sole revisioni richieste riguardavano la presentazione, quindi non bloccano la revisione narrativa.`,
    removed, autoPassed: true
  };
}
export function narrativeChecks(text) {
  return [...narrativeContentChecks(text), ...narrativePresentationChecks(text)];
}
export function narrativeContentChecks(text) {
  const narrative = clean(text).split(/## Narrative\s*\r?\n/i)[1]?.split(/## Italian Summary/i)[0];
  if (!narrative) return ['Missing ## Narrative / ## Italian Summary structure'];
  const issues = [];
  const words = narrative.replace(/^>.*$/gm, '').trim().split(/\s+/).filter(Boolean).length;
  if (words < 250) issues.push(`Narrative body is incomplete at ${words} words (minimum 250)`);
  if (words > 450) issues.push(`Narrative is materially overlong at ${words} words (maximum 400; allow only a small Codex trim)`);
  if (/^> Choice:/m.test(narrative)) issues.push('Choices are not authorized');
  const receptionistSpeech = narrative.split(/\r?\n/).filter(line => /^\s*\**Receptionist\**:\**\s*/i.test(line)).join(' ');
  const explicitlyClarifiesMinibar = /\b(?:I|we)\s+(?:(?:just|only)\s+)?(?:mean|meant|was talking about|am talking about)\b.{0,100}\b(?:minibar|drinks?|snacks?|room)\b/i.test(narrative)
    || /\bI[’']m\s+(?:just\s+)?(?:talking about|referring to)\b.{0,100}\b(?:minibar|drinks?|snacks?|room)\b/i.test(narrative)
    || /\b(?:just|only)\b.{0,70}\b(?:the\s+)?(?:minibar|drinks?\s+and\s+snacks?|room's\s+drinks?)\b/i.test(narrative)
    || /\b(?:minibar|drinks?|snacks?|room)\b.{0,50}\bactually\b/i.test(receptionistSpeech)
    || (/\b(?:minibar|drinks?|snacks?|room)\b.{0,140}\b(?:not|no)\b.{0,40}\b(?:personal|romantic|offer|invitation|date|connotations?)\b/i.test(receptionistSpeech)
      && /\b(?:not|no)\s+(?:(?:a\s+)?(?:personal|romantic)\s+(?:offer|invitation|date|compliment|connotations?)|making you an offer|an offer|an invitation|a date)\b/i.test(receptionistSpeech));
  if (!explicitlyClarifiesMinibar) issues.push('Receptionist must explicitly clarify in spoken dialogue that she meant the room minibar/drinks/snacks, not a personal romantic offer; the Italian summary does not count');
  if (!/\b(?:not|no)\b.{0,45}\b(?:personal|romantic|a date|asking you out|flirting|hitting on you|making you an offer|an offer|an invitation)\b/i.test(receptionistSpeech)) {
    issues.push('Receptionist must explicitly say in spoken dialogue that the minibar explanation is not a personal/romantic offer or invitation');
  }
  return issues;
}
export function narrativePresentationChecks(text) {
  const narrative = clean(text).split(/## Narrative\s*\r?\n/i)[1]?.split(/## Italian Summary/i)[0];
  if (narrative === undefined) return ['Missing narrative section; Codex cannot safely normalize the artifact'];
  const issues = [];
  const summary = clean(text).split(/## Italian Summary/i)[1] || '';
  if (!/^# Scene:/m.test(clean(text)) || !/## Italian Summary/i.test(text)) issues.push('Missing scene heading or Italian production metadata');
  if (/^---\s*$|^\s*#{1,3}\s|Production metadata:|Narrative word count|MISUNDERSTANDING_EVIDENCE:|MINIBAR_CLARIFICATION_EVIDENCE:|COMIC_RESPONSE_EVIDENCE:/im.test(summary)) issues.push('Remove extra production sections, English word-count claims and Reviewer evidence labels; keep only the brief Italian Summary');
  if (!narrative.trimStart().startsWith('> Visual:')) issues.push('Narrative must start with > Visual:');
  if ((narrative.match(/^> Visual:/gm) || []).length !== 1) issues.push('This test requires one Visual directive and one image');
  if (!/\*\*[^*]+:\*\*/.test(narrative)) issues.push('Missing required bold speaker labels');
  if (/^\*\*[^*]+:\*\*\s*\([^\r\n)]*\)/m.test(narrative)) issues.push('Move acting directions out of bold speaker labels and into prose');
  const words = narrative.replace(/^>.*$/gm, '').trim().split(/\s+/).filter(Boolean).length;
  if (words >= 400 && words <= 450) issues.push(`Narrative is slightly over the preferred 400-word ceiling (${words}); Codex may trim locally`);
  return issues;
}
export function codexNarrativeEditBudgetIssues(source, revised, maxChangedWords = 55, maxChangedRatio = 0.16) {
  const body = text => clean(text).split(/## Narrative\s*\r?\n/i)[1]?.split(/## Italian Summary/i)[0] || '';
  const words = text => body(text).replace(/^>.*$/gm, '').toLowerCase().match(/[a-z0-9’'-]+/g) || [];
  const a = words(source), b = words(revised);
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    matrix[i][j] = a[i - 1] === b[j - 1] ? matrix[i - 1][j - 1] + 1 : Math.max(matrix[i - 1][j], matrix[i][j - 1]);
  }
  const changed = a.length + b.length - 2 * matrix[a.length][b.length];
  const ratio = changed / Math.max(1, a.length, b.length);
  return changed > maxChangedWords || ratio > maxChangedRatio
    ? [`Codex changed ${changed} narrative words (${Math.round(ratio * 100)}%); limit is ${maxChangedWords} words and ${Math.round(maxChangedRatio * 100)}%. Return substantive repairs to Writer/Regia instead of rewriting the scene.`]
    : [];
}
export function writerRevisionScopeChecks(source, revised) {
  const bodyWordCount = text => {
    const body = clean(text).split(/## Narrative\s*\r?\n/i)[1]?.split(/## Italian Summary/i)[0] || '';
    return (body.replace(/^>.*$/gm, '').toLowerCase().match(/[a-z0-9’'-]+/g) || []).length;
  };
  const sourceWords = bodyWordCount(source);
  if (sourceWords >= 250) return codexNarrativeEditBudgetIssues(source, revised, 90, 0.30);
  // Underlength drafts need room for the missing story beats. Allow enough additive
  // text to reach the minimum while still blocking a wholesale scene replacement.
  const revisedWords = Math.max(1, bodyWordCount(revised));
  const maxChangedWords = Math.max(90, 250 - sourceWords + 80);
  const maxChangedRatio = Math.min(0.75, Math.max(0.30, maxChangedWords / revisedWords));
  return codexNarrativeEditBudgetIssues(source, revised, maxChangedWords, maxChangedRatio);
}
export function codexFinalReviewIssues({ reviewSummary, changesMade, finalCheck, sourceSha256, expectedSourceSha256, reviewerReport, sourceNarrative, finalNarrative }) {
  const issues = [];
  if (typeof reviewSummary !== 'string' || reviewSummary.trim().length < 20) issues.push('Codex review summary is missing or too short');
  if (typeof changesMade !== 'string' || changesMade.trim().length < 8) issues.push('Codex must state what it changed or explicitly state that no changes were needed');
  if (typeof finalCheck !== 'string' || finalCheck.trim().length < 20) issues.push('Codex final check is missing');
  if (sourceSha256 !== expectedSourceSha256) issues.push('Codex review source hash is stale or does not match the reviewed Writer draft');
  if (!/^[a-f0-9]{64}$/i.test(sourceSha256 || '')) issues.push('Invalid source SHA256');
  if (typeof finalNarrative !== 'string' || !finalNarrative.trim()) return [...issues, 'Codex final narrative is empty'];
  issues.push(...narrativeContentChecks(finalNarrative));
  issues.push(...narrativePresentationChecks(finalNarrative));
  if (typeof sourceNarrative === 'string') issues.push(...codexNarrativeEditBudgetIssues(sourceNarrative, finalNarrative));
  issues.push(...reviewPassEvidenceIssues(reviewerReport, finalNarrative));
  return [...new Set(issues)];
}
export function visualVerdict(text) {
  const score = Number(text.match(/^SCORE:\s*(\d+(?:\.\d+)?)\s*$/m)?.[1]);
  const major = text.match(/^MAJOR_ERROR:\s*(YES|NO)\s*$/m)?.[1];
  if (!/^REVIEW_SUCCESS\s*$/m.test(text) || !Number.isFinite(score) || score < 0 || score > 100 || !major) throw Error('Invalid visual review');
  return { score, majorError: major, accepted: score >= 80 && major === 'NO', retryHint: text.match(/^RETRY_HINT:\s*(.*)$/m)?.[1] || 'Improve request correspondence.' };
}
export function deterministicImagePlan(visual = '') {
  const sceneCue = typeof visual === 'string' ? visual.trim() : '';
  return {
    generator: 'normal',
    prompt: `Polished visual-novel illustration, close medium two-person shot framed waist-up across a hotel reception counter at dusk. Fill the frame with exactly two adult characters, both heads and faces fully visible and equally prominent: Alex, a 28-year-old blonde man in a clearly visible black leather jacket, and one amused adult female receptionist in a simple uniform facing him. Crop out lobby seating and doorways; use a plain softly blurred empty wall behind them, with only a small brass desk lamp for setting. Keep their bodies separate, expressions readable, and background completely empty. Playful, non-explicit mood. ${sceneCue}`,
    negative_prompt: 'single person, one person, missing character, cropped head, hidden face, crowd, guests, seated man, bystanders, background people, silhouettes, third person, extra person, duplicate people, extra faces, people in posters, people in photographs, mirror reflections, text, lettering, watermark, fused bodies, severe anatomy errors, explicit content'
  };
}
export function imageDimensionsForJob(state) {
  const size = state?.job?.imageSize;
  if (!size) return { width: 1920, height: 1080 };
  const { width, height } = size;
  if (!Number.isInteger(width) || width < 512 || width > 2048 || !Number.isInteger(height) || height < 512 || height > 2048) {
    throw Error('Requested image dimensions must be integers from 512 to 2048');
  }
  return { width, height };
}
function jsonObject(text) {
  const raw = clean(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}
async function checkedFile(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size) throw Error('Missing or empty asset: ' + file);
  return { path: file, bytes: stat.size, sha256: sha(await fs.readFile(file)) };
}
async function systemPrompt(model) {
  const configPath = path.join(lmRoot, 'apps', 'bionic', '.internal', 'user-concrete-model-default-config', model.indexedModelIdentifier + '.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const prompt = config.operation?.fields?.find(field => field.key === 'llm.prediction.systemPrompt')?.value;
  if (typeof prompt !== 'string' || !prompt.trim()) throw Error('Configured system prompt missing for ' + model.displayName);
  return prompt;
}
export async function predictRole(role, prompt, { jobId = crypto.randomUUID(), record = async () => {}, runner = run, memory = new MemoryManager(lms, runner), catalog = null, chatApi = null, modelIdentifierOverride = null, systemPromptOverride = null, predictionOverrides = {} } = {}) {
  if (!catalog) {
    const result = await runner(lms, ['ls', '--json']);
    if (result.code !== 0) throw Error('Cannot read model catalog');
    catalog = JSON.parse(result.stdout);
  }
  const spec = specs[role];
  if (!spec) throw Error('Unknown specialized role');
  const models = catalog.filter(m => m.type === 'llm' && (modelIdentifierOverride ? m.indexedModelIdentifier === modelIdentifierOverride : spec.match.test(m.displayName)));
  if (models.length !== 1) throw Error('Role model is missing or ambiguous: ' + role);
  if ((await memory.list()).length) throw Error('Another local LLM is loaded; refusing concurrent role load');
  const model = models[0];
  const localChat = chatApi || new LocalChatApi(lms, runner);
  const ownChatLifecycle = !chatApi;
  const identifier = `production-${role}-${jobId}`;
  await record({ stage: role, event: 'load_requested', model: model.indexedModelIdentifier });
  const loaded = await runner(lms, ['load', model.modelKey, '--identifier', identifier, '--context-length', '8192', '--gpu', spec.gpu, '--parallel', '1', '--ttl', '900', '--yes'], { timeoutMs: 240000 });
  if (loaded.code !== 0) throw Error('Model load failed: ' + role);
  try {
    const configPath = path.join(lmRoot, 'apps', 'bionic', '.internal', 'user-concrete-model-default-config', model.indexedModelIdentifier + '.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    for (const [key, value] of Object.entries(predictionOverrides)) {
      const field = config.operation?.fields?.find(item => item.key === key);
      if (field) field.value = value;
      else config.operation.fields.push({ key, value });
    }
    const configuredSystem = config.operation?.fields?.find(field => field.key === 'llm.prediction.systemPrompt')?.value;
    if (typeof configuredSystem !== 'string' || !configuredSystem.trim()) throw Error('Configured system prompt missing for ' + model.displayName);
    const selectedSystem = systemPromptOverride || configuredSystem;
    const system = role === 'reviewer'
      ? `${selectedSystem}\n\nLANGUAGE OVERRIDE FOR THIS REVIEW: Every part of your review after the exact English verdict line MUST be written in Italian. This is mandatory even though the narrative itself is English. Keep the verdict exactly REVIEW: PASS or REVIEW: REVISION REQUIRED.`
      : selectedSystem;
    await record({ stage: role, event: 'input_ready', systemSha256: sha(system), instructionSha256: sha(prompt) });
    const generated = await localChat.predict(identifier, prompt, system, config, role);
    await record({ stage: role, event: 'prediction_complete', model: model.indexedModelIdentifier, responseSha256: sha(generated.text), apiStats: generated.stats, responseIdStored: generated.responseIdStored });
    return generated.text;
  } finally {
    const instance = (await memory.list()).find(m => m.identifier === identifier);
    if (instance) {
      if (instance.status !== 'idle' || instance.queued !== 0) throw Error('Owned role model remains busy; refuse unsafe unload');
      const unloaded = await runner(lms, ['unload', identifier]);
      if (unloaded.code !== 0 || (await memory.list()).some(m => m.identifier === identifier)) throw Error('Owned role model unload failed');
      await record({ stage: role, event: 'unloaded', identifier });
    }
    if (ownChatLifecycle) await localChat.stopIfOwned();
  }
}
export function writerInstruction(canonical, summary, previous = '', feedback = '') {
  const start = canonical.search(/^## Character Profile\s*$/m);
  const end = canonical.search(/^## Visual Asset Specification\s*$/m);
  const scopedFacts = start >= 0 && end > start ? canonical.slice(start, end).trim() : canonical;
  return `CANONICAL FACTS:\n${scopedFacts}\n\nAPPROVED SCENE BRIEF:\n${summary}\n\n${previous ? '<previous_draft_to_revise>\n' + previous + '\n</previous_draft_to_revise>\n' : ''}${feedback ? '<review_feedback>\n' + feedback + '\n</review_feedback>\n' : ''}
Write one complete English scene for an adult visual novel. The narrative body must be 250–400 words inclusive. Aim for 300–330 narrative words so the scene has room to develop and remains safely above the minimum; exclude headings, the Visual directive and Italian summary from the count. Follow the approved brief and canon. For this scene: keep one continuous interaction at the hotel reception desk; Alex is adult, blonde, sarcastic and sociable, wearing his black leather jacket; the receptionist is adult. Preserve this beat order: (1) a line Alex can reasonably mistake for a romantic offer, (2) he responds as if she is flirting, (3) the receptionist clearly says in her spoken dialogue that she means the room's minibar drinks/snacks and that this is not a personal or romantic offer, (4) after the clarification Alex tries to save face with a brief, plausible improvisation, then gives a clear comic spoken response. Use a separate paragraph for each line of dialogue and prefix every line with exactly **Alex:** or **Receptionist:** so the speaker is unambiguous. Keep the tone playful and lightly flirtatious; no scene change, time jump or unauthorized Choice. Make dialogue sound like these people, not like a checklist. Use visual description only when it strengthens the scene; do not include Sound or Music directions. Do not pad with filler or write future events.
For revision, preserve strong lines and passages that do not need changing. Correct only the substantiated content findings in the Reviewer brief; do not rewrite unaffected paragraphs or compress a scene that already meets the requested length. If the required story content cannot be repaired locally, say so in the Italian summary rather than inventing a new direction.
Output the full artifact in this shape: # Scene: title; ## Narrative; one opening > Visual: describing the reception scene; prose and **Speaker:** labels; ## Italian Summary with a brief accurate Italian production summary. Put actions in prose, not inside speaker labels. Formatting imperfections are acceptable; preserve the story first. Return only the artifact.`;
}
export function reviewerInstruction(canonical, summary, narrative, checks) {
  return `CANONICAL PROJECT FILE:\n${canonical}\nAUTHORIZED SCOPE:\n${summary}\nWRITER OUTPUT:\n${narrative}\nCONTENT PRECHECKS ONLY:\n${checks.join('\n') || 'PASS: deterministic content prechecks found no issues.'}
REVIEW TASK: Review only substantive narrative issues: canon and continuity, adult characters, approved playful mild flirtation, scene scope, whether the misunderstanding is plausible, whether the spoken clarification and Alex's comic reaction are actually present, and whether the scene feels complete and engaging. Do not block or request Writer revisions for headings, Markdown, speaker-label styling, acting directions, directive placement/count, summary formatting, or other presentation issues; Codex will repair presentation after content review. Do not treat a small length variation inside 250–400 words as a content failure. A PASS must provide the three exact evidence lines: MISUNDERSTANDING_EVIDENCE: "..."; MINIBAR_CLARIFICATION_EVIDENCE: "..."; COMIC_RESPONSE_EVIDENCE: "...". The clarification evidence may quote either the exact spoken minibar/drinks/snacks reference or the exact spoken line ruling out a personal/romantic offer; the deterministic content check independently verifies both lines are present. Comic response must be Alex dialogue. For each substantive revision finding include a separate NARRATIVE_EVIDENCE: "..." exact quote. Never invent or paraphrase evidence. Do not submit style preference as a required revision. If content is substantively missing, explain one localized repair target and what surrounding material to preserve.
FORMAT AUTHORITY: Presentation is checked and repaired by Codex after this review. The artifact normally has # Scene, ## Narrative, an opening Visual directive, and ## Italian Summary, but format defects alone must never change the verdict. Do not invent requirements or require that sarcasm forbid confusion. Review only narrative substance.
Rispondi con una sola prima riga esatta REVIEW: PASS oppure REVIEW: REVISION REQUIRED. Tutte le spiegazioni successive devono essere in italiano. Non riscrivere il testo: identifica solo problemi materiali con prove e correzioni richieste al Writer. /no_think`;
}
export async function produceScene(filename, adapters = {}) {
  const store = adapters.store || new Store();
  const state = await store.read(filename);
  if (state.owner !== 'codex' || state.status !== 'running' || !state.job?.approval) throw Error('An approved running Codex job is required');
  if (state.job.phase !== 'single_scene_text_image') throw Error('This production profile is only for an approved single_scene_text_image phase');
  return store.locked('production-global.md', async () => {
    const canonical = await fs.readFile(store.project(filename), 'utf8');
    if (sha(canonical) !== state.job.projectSha256) throw Error('Canonical file changed before production');
    const out = path.join(adapters.productionRoot || productionRoot, state.projectId, state.job.id);
    await fs.mkdir(out, { recursive: true });
    const marker = path.join(out, 'started.json');
    await fs.writeFile(marker, JSON.stringify({ jobId: state.job.id, startedAt: new Date().toISOString() }), { flag: 'wx' });
    // A second call is deliberately refused, even after failure: inspect effects before a new job.
    const events = [];
    const record = async event => { events.push({ at: new Date().toISOString(), ...event }); await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(events, null, 2)); };
    const runner = adapters.run || run;
    const memory = new MemoryManager(lms, runner);
    const current = await memory.list();
    if (current.length) throw Error('Production requires local LLM memory to be free; will not unload unrelated models');
    const catalogResult = await runner(lms, ['ls', '--json']);
    if (catalogResult.code !== 0) throw Error('Cannot read model catalog');
    const catalog = JSON.parse(catalogResult.stdout);
    const writerModelIdentifier = process.env.BIONIC_WRITER_MODEL_ID || null;
    const predict = adapters.predict || ((role, prompt) => predictRole(role, prompt, {
      jobId: state.job.id, runner, record, memory, catalog,
      modelIdentifierOverride: role === 'writer' ? writerModelIdentifier : null
    }));
    let narrative = '', feedback = '', accepted = false, acceptedReview = '', reviewerCycles = 0;
    for (let cycle = 1; cycle <= 3; cycle++) {
      reviewerCycles = cycle;
      const previous = narrative;
      narrative = await predict('writer', writerInstruction(canonical, state.job.summary, previous, feedback));
      await fs.writeFile(path.join(out, `writer-${cycle}.md`), narrative);
      const contentChecks = narrativeContentChecks(narrative);
      const presentationChecks = narrativePresentationChecks(narrative);
      if (previous) contentChecks.push(...writerRevisionScopeChecks(previous, narrative).map(issue => `Revision scope: ${issue}`));
      if (previous && sha(previous) === sha(narrative)) contentChecks.push('Writer repeated the rejected draft unchanged; make a localized correction to the cited content issue.');
      let review = await predict('reviewer', reviewerInstruction(canonical, state.job.summary, narrative, contentChecks));
      const filteredReview = stripPresentationOnlyFindings(review, narrative);
      review = filteredReview.review;
      let verdict = reviewVerdict(review);
      let evidenceChecks = verdict === 'PASS' ? reviewPassEvidenceIssues(review, narrative) : reviewFindingEvidenceIssues(review, narrative, contentChecks);
      if (evidenceChecks.length) {
        await record({ stage: 'narrative_review', cycle, event: 'report_rejected_unverifiable_quotes', evidenceChecks });
        const retryChecks = [...contentChecks, `Your previous ${verdict} report contained missing or unverifiable narrative quotations: ${evidenceChecks.join('; ')}. Review the same unchanged Narrative again. Never invent or paraphrase evidence.`];
        review = await predict('reviewer', reviewerInstruction(canonical, state.job.summary, narrative, retryChecks));
        await fs.writeFile(path.join(out, `reviewer-${cycle}-evidence-retry.md`), review);
        verdict = reviewVerdict(review);
        evidenceChecks = verdict === 'PASS' ? reviewPassEvidenceIssues(review, narrative) : reviewFindingEvidenceIssues(review, narrative, contentChecks);
        if (verdict === 'PASS' && evidenceChecks.length) throw Error('Reviewer repeated PASS with unverifiable evidence quotes');
      }
      await fs.writeFile(path.join(out, `reviewer-${cycle}.md`), review);
      await record({ stage: 'narrative_review', cycle, verdict, contentChecks, presentationChecks, presentationFindingsRemoved: filteredReview.removed, formatOnlyReviewPromoted: filteredReview.autoPassed, reviewerEvidenceChecks: evidenceChecks });
      if (verdict === 'PASS' && !contentChecks.length && !evidenceChecks.length) { accepted = true; acceptedReview = review; break; }
      const trustedReview = evidenceChecks.length ? 'The Reviewer report did not provide verifiable quotations. Ignore its narrative claims and proposed edits.' : review;
      feedback = trustedReview + '\nSubstantive content checks to correct (preserve all unaffected lines and paragraphs):\n' + [...contentChecks, ...evidenceChecks].join('\n');
    }
    if (!accepted) throw Error('Narrative not approved after three Writer/Reviewer cycles');
    const draftPath = path.join(out, 'narrative-draft.md');
    const pendingPath = path.join(out, 'narrative-review-ready.json');
    const draftSha256 = sha(narrative);
    await fs.writeFile(draftPath, narrative, { flag: 'wx' });
    await fs.writeFile(path.join(out, 'reviewer-final.md'), acceptedReview, { flag: 'wx' });
    await fs.writeFile(pendingPath, JSON.stringify({
      status: 'awaiting_codex_review', projectFile: filename, projectId: state.projectId, jobId: state.job.id,
      draftPath, draftSha256, reviewerCycles, reviewerReport: acceptedReview, createdAt: new Date().toISOString()
    }, null, 2), { flag: 'wx' });
    await record({ stage: 'narrative_review', event: 'awaiting_codex_review', reviewerCycles, draftPath, draftSha256 });
    return { status: 'awaiting_codex_review', narrativePath: draftPath, narrative, narrativeSha256: draftSha256, reviewer: 'PASS', reviewerCycles, reviewerReport: acceptedReview, presentationChecks: narrativePresentationChecks(narrative), evidencePath: path.join(out, 'evidence.json') };
  }).catch(async error => {
    const out = path.join(adapters.productionRoot || productionRoot, state.projectId, state.job.id);
    const files = await fs.readdir(out).catch(() => []);
    throw Error(`${error.message}\nEVIDENCE_DIRECTORY: ${out}\nAVAILABLE_PARTIAL_FILES: ${files.join(', ')}\nThese partial artifacts are not approved production.`);
  });
}

export async function finalizeReviewedScene(filename, input, adapters = {}) {
  const store = adapters.store || new Store();
  const state = await store.read(filename);
  if (state.owner !== 'codex' || state.status !== 'running' || !state.job?.approval) throw Error('An approved running Codex job is required');
  if (state.job.phase !== 'single_scene_text_image') throw Error('This final review is only valid for an approved single_scene_text_image phase');
  return store.locked('production-global.md', async () => {
    const out = path.join(adapters.productionRoot || productionRoot, state.projectId, state.job.id);
    if (await fs.stat(path.join(out, 'codex-narrative-review.json')).catch(() => null)) throw Error('Codex narrative review was already finalized; inspect partial effects and do not replay');
    const pendingPath = path.join(out, 'narrative-review-ready.json');
    const pending = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
    if (pending.status !== 'awaiting_codex_review' || pending.jobId !== state.job.id || pending.projectFile !== filename) throw Error('No matching narrative is awaiting Codex review');
    const draft = await fs.readFile(pending.draftPath, 'utf8');
    if (sha(draft) !== pending.draftSha256) throw Error('Writer draft changed after Reviewer approval');
    const canonical = await fs.readFile(store.project(filename), 'utf8');
    if (sha(canonical) !== state.job.projectSha256) throw Error('Canonical Project File changed before Codex final review');
    const reviewIssues = codexFinalReviewIssues({ ...input, sourceNarrative: draft, expectedSourceSha256: pending.draftSha256, reviewerReport: pending.reviewerReport });
    if (reviewIssues.length) throw Error('Codex final review rejected: ' + reviewIssues.join('; '));

    const narrativePath = path.join(out, 'scene.md');
    const temporaryPath = path.join(out, 'scene.codex-final.tmp');
    await fs.writeFile(temporaryPath, input.finalNarrative, { flag: 'wx' });
    await fs.rename(temporaryPath, narrativePath);
    const codexReview = {
      status: 'passed', sourceSha256: pending.draftSha256, finalSha256: sha(input.finalNarrative),
      reviewSummary: input.reviewSummary, changesMade: input.changesMade, finalCheck: input.finalCheck,
      checks: 'passed', finalizedAt: new Date().toISOString()
    };
    const reviewPath = path.join(out, 'codex-narrative-review.json');
    await fs.writeFile(reviewPath, JSON.stringify(codexReview, null, 2), { flag: 'wx' });
    pending.status = 'codex_finalized';
    pending.finalSha256 = codexReview.finalSha256;
    pending.finalizedAt = codexReview.finalizedAt;
    await fs.writeFile(pendingPath, JSON.stringify(pending, null, 2));
    const evidencePath = path.join(out, 'evidence.json');
    const events = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
    events.push({ at: new Date().toISOString(), stage: 'codex_narrative_review', event: 'final_review_passed', ...codexReview });
    await fs.writeFile(evidencePath, JSON.stringify(events, null, 2));
    const record = async event => { events.push({ at: new Date().toISOString(), ...event }); await fs.writeFile(evidencePath, JSON.stringify(events, null, 2)); };
    const runner = adapters.run || run;
    const memory = new MemoryManager(lms, runner);
    if ((await memory.list()).length) throw Error('Production requires local LLM memory to be free before image planning');
    const catalogResult = await runner(lms, ['ls', '--json']);
    if (catalogResult.code !== 0) throw Error('Cannot read model catalog');
    const catalog = JSON.parse(catalogResult.stdout);
    const predict = adapters.predict || ((role, prompt) => predictRole(role, prompt, { jobId: state.job.id, runner, record, memory, catalog }));
    const controllerAvailable = catalog.some(model => model.type === 'llm' && specs.imageController.match.test(model.displayName));
    return produceSceneAssets({ filename, store, state, canonical, out, narrative: input.finalNarrative, narrativePath, codexReview, reviewPath, reviewerCycles: pending.reviewerCycles, events, predict, memory, adapters, controllerAvailable });
  }).catch(async error => {
    const out = path.join(adapters.productionRoot || productionRoot, state.projectId, state.job.id);
    const files = await fs.readdir(out).catch(() => []);
    throw Error(`${error.message}\nEVIDENCE_DIRECTORY: ${out}\nAVAILABLE_PARTIAL_FILES: ${files.join(', ')}\nInspect the Codex review record and production evidence before any retry.`);
  });
}

async function produceSceneAssets({ filename, store, state, canonical, out, narrative, narrativePath, codexReview, reviewPath, reviewerCycles, events, predict, memory, adapters, controllerAvailable = true }) {
    const record = async event => { events.push({ at: new Date().toISOString(), ...event }); await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(events, null, 2)); };
    const visual = narrative.match(/^> Visual:\s*(.*)$/m)?.[1];
    const originalRequest = `Approved Project File:\n${canonical}\nScene opening Visual:\n${visual}\nExactly two adult principal characters: Alex, blonde man age 28 in black leather jacket, at hotel reception desk, and amused adult female receptionist behind desk. Medium shot, readable faces, playful non-explicit visual novel scene.`;
    const plan = controllerAvailable
      ? jsonObject(await predict('imageController', `You are in PROMPT_PLANNING mode. Tools are executed by the coordinator's deterministic controller. Return only JSON with keys generator (normal), prompt (concise English image generation prompt), negative_prompt. Preserve canonical appearance and exactly two separate adult people. Do not claim generation, review, publication, or invent paths.\n${originalRequest}\n/no_think`))
      : deterministicImagePlan(visual);
    if (!controllerAvailable) await record({ stage: 'image_planning', event: 'deterministic_fallback', reason: 'Image Controller model is absent from the local LM Studio catalog' });
    if (plan.generator !== 'normal' || typeof plan.prompt !== 'string' || !plan.prompt.trim() || typeof plan.negative_prompt !== 'string') throw Error('Invalid Image Controller plan');
    await fs.writeFile(path.join(out, 'image-plan.json'), JSON.stringify({ ...plan, originalRequest }, null, 2));
    const connect = async worker => {
      if (adapters.connect) return adapters.connect(worker);
      const client = new Client({ name: 'bionic-production-controller', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(lmRoot, worker, 'mcp', 'server.mjs')], stderr: 'pipe' });
      await client.connect(transport);
      return client;
    };
    const imageWorker = await connect('image-worker');
    const imageSize = imageDimensionsForJob(state);
    let assetWorker;
    const call = async (client, name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
      const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
      if (result.isError || /^(FAILED|REVIEW_FAILED|PUBLISH_FAILED|FETCH_FAILED|FINALIZE_FAILED)/m.test(text)) throw Error(name + ' failed: ' + text.slice(0, 1000));
      return text;
    };
    try {
      let selected = null, retry = '';
      for (let attempt = 1; attempt <= 5; attempt++) {
        if ((await memory.list()).length) throw Error('A local LLM was loaded during image generation; stop to preserve VRAM ownership');
        const seed = crypto.randomInt(1, 2147483647);
        const name = `${state.projectId}_${state.job.id}_attempt_${String(attempt).padStart(2, '0')}.png`;
        const generated = await call(imageWorker, 'generate_image', { generator: 'normal', prompt: plan.prompt + (retry ? '\nCorrect this issue: ' + retry : ''), negative_prompt: plan.negative_prompt, seed, filename: name, ...imageSize });
        if (!/^SUCCESS\s*$/m.test(generated)) throw Error('Generation did not confirm success');
        const imagePath = generated.match(/^PATH:\s*(.*)$/m)?.[1]?.trim();
        const file = await checkedFile(imagePath);
        const review = await call(imageWorker, 'review_with_codex', { image_path: imagePath, original_request: originalRequest });
        const verdict = visualVerdict(review);
        await record({ stage: 'image_review', attempt, seed, ...file, ...verdict, review });
        if (verdict.accepted) { selected = { ...file, ...verdict, attempt }; break; }
        retry = verdict.retryHint;
      }
      if (!selected) throw Error('No image approved after five attempts; unapproved assets were not published');
      const finalized = await call(imageWorker, 'finalize_image', { source_path: selected.path, final_filename: `${state.projectId}_${state.job.id}_hotel_reception.png` });
      const finalPath = finalized.match(/^FINAL_PATH:\s*(.*)$/m)?.[1]?.trim();
      const final = await checkedFile(finalPath);
      if (final.sha256 !== selected.sha256) throw Error('Finalized image differs from reviewed image');
      await record({ stage: 'finalized', ...final });
      const published = await call(imageWorker, 'publish_image', { local_path: finalPath });
      if (!/^PUBLISH_SUCCESS\s*$/m.test(published)) throw Error('Publication not confirmed');
      const remotePath = published.match(/^REMOTE_PATH:\s*(.*)$/m)?.[1]?.trim();
      if (!remotePath?.startsWith('ImageWorker/final/')) throw Error('Unexpected published asset path');
      await record({ stage: 'published', remotePath });
      assetWorker = await connect('asset-worker');
      const assetDirectory = path.join('C:\\AI\\assets', state.projectId, state.job.id);
      await fs.mkdir(assetDirectory, { recursive: true });
      const destination = path.join(assetDirectory, path.basename(finalPath));
      await call(assetWorker, 'fetch_image', { remote_path: remotePath, destination_path: destination });
      const transferred = await checkedFile(destination);
      if (transferred.sha256 !== final.sha256) throw Error('Transferred image hash differs from approved final');
      await record({ stage: 'transferred', ...transferred });
      const result = { status: 'completed', narrativePath, narrativeSha256: sha(narrative), reviewer: 'PASS', reviewerCycles, codexReview: { ...codexReview, path: reviewPath }, image: { ...selected, finalPath, remotePath, transferredPath: destination }, evidencePath: path.join(out, 'evidence.json') };
      await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      const currentFiles = await fs.readdir(out).catch(() => []);
      throw Error(`${error.message}\nEVIDENCE_DIRECTORY: ${out}\nAVAILABLE_PARTIAL_FILES: ${currentFiles.join(', ')}\nNarrative is finalized; inspect evidence before retrying.`);
    } finally { await imageWorker.close(); await assetWorker?.close(); }
}


