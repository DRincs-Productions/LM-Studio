---
name: narration
description: Draft and revise narrative scenes for visual novels using the project's canon, scene contract, prose structure, and inline visual/audio/animation cue format. Use when creating or reviewing narrative scenes and their presentation cues.
---

# Narrative

Write visual-novel scenes whose prose carries the story and whose optional cue lines specify presentation. Follow the user's brief, the canonical Project File, and the approved `SceneContract` in that order. Do not infer canon from examples in this skill.

## Required Companion Skills

This skill defines the project artifact and cue format; companion skills provide their own specialized workflows. Refer to them by name and follow their `SKILL.md` directly. Do not restate their instructions here.

For narrative drafting, install and use:

- `chapter-writing` for chapter drafting and scope.
- `scene-craft` for scene structure and beats.
- `voice-style` when a project voice/style sheet is needed.

Install and invoke these only when the corresponding task is in scope:

- `interactive-fiction` for branching narrative.
- `adaptation` for audiobook, picture-book, comic, screenplay, or translation work. It defines those medium-specific formats; they do not replace this project's visual-novel cue format.
- `image-direction`, `image-prompt`, `image-generate`, `image-review`, `image-refine`, and `image-deliver` for image direction and the relevant production stages.
- `musical-aesthetic-listening` and `real-sound` for musical/sound direction and production; `earshot` for auditory verification when judging sound.
- `voice-speech-listening` for spoken-voice assessment.

Companion skills are separate installs; installing `narration` does not install them. Before relying on a companion skill, check that it is installed for the current agent. If it is missing, explain which skill is needed and give its installation command rather than silently duplicating its workflow or claiming it was used.

### Companion-skill installation

The commands below install the Story Skills set globally for Codex. Run the full command once if the narrative companions are not installed; omit `--skill '*'` and list only requested skill names when installing selectively. For another supported agent, replace `codex` with its Skills CLI agent ID.

```powershell
npx skills@latest add danjdewhurst/story-skills --skill '*' --agent codex -g -y
```

Install image/audio companion skills from their repository when needed:

```powershell
npx skills@latest add simota/image-skills --skill '*' --agent codex -g -y
npx skills@latest add sonicfieldlabs/akouo --skill '*' --agent codex -g -y
npx skills@latest add Leonxlnx/earshot --skill '*' --agent codex -g -y
```

Check which skills are available before use:

```powershell
npx skills@latest ls -g --agent codex
```

`narration` itself can be installed from this repository as described in [Installation](#installation). Companion repositories may publish updates independently; use the repository's current default branch or a verified tag supported by the CLI.

<!-- narration-runtime:start -->
## Scene Artifact

Write the entire artifact in English, even when the brief or its sample dialogue uses another language. Preserve character and place names, but translate all narration, dialogue, visual descriptions, and summaries into natural English. Do not leave Italian sentences or untranslated common words in the artifact. If the brief requests a regional dialect, convey its voice through English phrasing, rhythm, and idiom rather than switching languages. Use this Markdown envelope:

```markdown
# Scene: <title>

## Scene Setup
<A short, concrete description of where the characters are, what they are doing at the opening, and the key visible details.>

## Narrative
> Visual: <opening shot that frames the setup>

**Speaker (mood/state when relevant):** "One spoken turn."

<A short action paragraph, when needed.>

**Speaker (mood/state when relevant):** "The next spoken turn."

## English Summary
<A short, accurate summary.>
```

Let dialogue carry discoveries, disagreements, and decisions. By default, spoken dialogue in the Narrative section should contain more words than its narration and action prose; omit Visual cue lines from this comparison. This is a craft rule for the Writer and final editor, not a hard server gate or a demand to pad dialogue. Let narration exceed dialogue when speech naturally recedes, especially during adult intimacy or sex, fights, action, suspense, physical tasks, and deliberately quiet beats. Keep the opening tableau in Scene Setup and story developments in Narrative. Use one quoted utterance per speaker line, formatted `**Name:** "..."` or `**Name (Mood or State):** "..."`. Include a parenthetical whenever the brief or canon gives the character an ongoing condition, mood, or delivery state that matters to the line or to the player's interpretation. Repeat an ongoing state on every spoken turn for as long as it remains true, even after an action paragraph; do not make the player infer a game-visible state from prose alone. For example, if a character is already drunk, label each of their spoken turns `(Drunk)`; if a character persistently struggles to find words, label their turns `(Hesitant)` or `(Searching for Words)` as appropriate. Add a line-specific mood or delivery state when it clarifies that line. Do not turn stable background traits such as nationality, wealth, or intelligence into state labels, and do not invent a generic `(Neutral)` label when no state is established. Keep names and state labels outside the quotation marks. Put actions in separate paragraphs and repeat the speaker label after an intervening action. Do not repeat the setup or what dialogue already conveys. Make the specified endpoint the last story action or spoken line. Check that every line of dialogue is in English and that the summary attributes actions and statements correctly. A brief's requested dialogue language never overrides the project's English-output requirement; translate its meaning and preserve the requested voice without copying foreign-language sentences.

### Visual-novel dialogue labels and shouting

Treat every spoken turn as a separately attributed game dialogue line so the client can assign it to a character. Write the character name first, then a concise parenthetical state when one is established and relevant, then the quoted dialogue: `**Alice (Angry):** "..."`. A state label is optional only when no relevant state applies. If the brief establishes a persistent state such as intoxication or difficulty speaking, include it on every spoken turn for as long as it applies, repeating it after intervening action. Use a line-specific mood or delivery state when it helps the player interpret that line. Do not put the speaker attribution after the quote as prose such as `"..." Alice said.` Do not invent neutral states or label stable background traits such as nationality, wealth, or intelligence. Keep narration and actions in their own paragraphs, and repeat the speaker label after each intervening action.

When a character is clearly shouting, write every spoken word in ALL CAPS while preserving punctuation, for example `**Alice (Angry, shouting):** "HEY!!!?"`. Keep the character name and state label in ordinary capitalization. The Writer should apply this while drafting; the final editor (Codex or Venice) must check and correct the dialogue format and capitalization directly. The server may validate the explicit label syntax and can enforce uppercase when the label says `shouting` or `yelling`; it cannot reliably infer every shout from prose, so the final editor must also check the scene context.

### Character voice, cadence, and punctuation

Make each character sound like this person, in this moment, speaking to these people. Shape vocabulary, sentence length, syntax, directness, confidence, humor, and willingness to explain things around the character's established background, knowledge, temperament, relationships, and immediate situation. Let characters reveal personality through what they notice, avoid, misunderstand, repeat, or choose not to say; do not make every speaker equally articulate or give them interchangeable polished banter. Respect the brief and canon over assumptions, and avoid turning nationality, class, education, disability, or intoxication into a stock accent or joke.

When a character struggles to find words, show it with readable pauses, a restart, a correction, or an incomplete thought. Preserve the project's required English output: translate the meaning and carry the struggle into natural English instead of inserting foreign-language sentences, fake phonetic spelling, or caricatured grammar. A character's speech difficulty is a behavior to portray, not a diagnosis to invent.

Make the prose feel spoken and lived-in rather than mechanically assembled. Vary sentence length and structure when the beat changes; use fragments, longer turns, interruptions, or pauses only when they fit the viewpoint and moment. Use commas, dashes, periods, questions, and occasional ellipses to make intention and rhythm legible. Punctuation should add energy or nuance, not decoration: avoid making every line clipped, trailing off, or emphatic. During final editing, Codex or Venice should directly smooth formulaic cadence, improve fitting punctuation, and sharpen voice distinctions while preserving facts, scene scope, and each character's established way of speaking.

### Reworking long narration

When a continuous narrator passage becomes too long for a dialogue-led visual novel, preserve its facts and beat while breaking it into shorter, playable parts. The editor may use any combination of these optional, joinable forms:

- One or more concise voiceover lines, formatted as `**Narrator:** "..."`.
- A standalone `> Visual:` direction for a supported image, silhouette, framing, or other visual medium.
- A concise narrator line or action sentence that summarizes the passage, with a contextual written sound when that sound adds rhythm or clarity.

No passage needs all three forms. Keep every form optional and avoid repeating the same information across voiceover, prose, and visual direction. Do not invent a speaking narrator if the brief excludes voiceover; use concise prose instead. Visual directions describe a moment and never claim that an image or other asset has been generated.

The opening Visual cue is required. Omit additional cues the brief forbids. Cues must be standalone lines and use only canon-supported details. Keep story facts understandable without cues.

### Expressive sounds

Use onomatopoeia and vocalizations with purpose, following [Expressive Sounds](../expressive-sounds/SKILL.md) for examples, density, and spoken delivery. In adult erotic scenes and action/fight scenes with sparse dialogue, include several natural written sound forms across the relevant beats, including vocalizations and non-vocal contact or movement sounds when supported. Descriptions of breathing alone do not satisfy this rule. These sounds belong in prose or dialogue, not NCF cue lines. The Shadow Controller bundles those rules with this skill for the Writer and editors.

## Narrative Cue Format (NCF)

NCF borrows medium-specific craft ideas from Story Skills and defines project-specific extensions for interactive visual-novel presentation. These are authoring directives, not standalone asset approvals.

### Visual

```text
> Visual: <concise description of the exact moment to illustrate>
```

This is the current project convention consumed by the scene-to-image pipeline. Place cues at meaningful changes in setting, action, or emotional beat; do not impose a fixed count. Include only canon-supported characters, appearance, props, and setting details. Describe the image moment, not a sequence of actions.

### Music

```text
> Music: play | cue=<id-or-unassigned> | loop=<true-or-false> | trigger=<story_event> | stop=<story_event>
```

Add music only when the approved brief or Project File requests it. Reuse a supplied cue ID when one exists; otherwise write `unassigned`. Trigger and stop are narrative event identifiers, not guessed timestamps or durations. Use `scene_end` when music should continue through the scene.

### Sound effect

```text
> SFX: play | cue=<id-or-unassigned> | trigger=<story_event>
```

Use for a discrete, non-musical sound, only when requested or authorized. Describe its sound in the approved audio brief; never invent a file path or claim an asset exists. The audio brief defines stop/loop behavior for sustained sounds.

### Animation

```text
> Animation: play | asset=<id-or-unassigned> | clip=<clip-id-or-unassigned> | loop=<true-or-false> | trigger=<story_event> | stop=<story_event>
```

Keep the directive engine-agnostic. Do not assume Spine, Spine2D, or another tool/runtime has been selected. Use `unassigned` for identifiers not present in the Project File; do not invent rig-specific commands.

<!-- narration-runtime:end -->

### Combined example

```markdown
# Scene: The Greenhouse Signal

## Scene Setup
Tali waits beneath the greenhouse grow lamps. Ivo watches the receiver from the open doorway.

## Narrative
> Visual: Tali stands beneath the greenhouse grow lamps as the receiver begins to glow; Ivo watches from the open doorway.
> Music: play | cue=greenhouse-signal | loop=true | trigger=receiver_signal_begins | stop=scene_end

The receiver crackled once. Tali looked up as a green point of light appeared on its display.
> SFX: play | cue=unassigned | trigger=receiver_crackles

The orchid's closed petals trembled in the warm air.
> Animation: play | asset=unassigned | clip=petals_tremble | loop=false | trigger=orchid_trembles | stop=motion_ends

## English Summary
Tali and Ivo notice a signal in the greenhouse.
```

The sample cue identifiers are illustrative; they do not assert that matching assets exist.

## Writing and Review Rules

- Canon and approved scope outrank this skill, examples, and model suggestions.
- Base the required opening Visual cue on the approved brief or Project File. Add further cues only when supported. In particular, do not add music or SFX just to make a scene feel cinematic.
- Preserve story clarity when all cues are removed. Keep prose, dialogue, character knowledge, chronology, and the endpoint complete on their own.
- Never fabricate asset paths, registered IDs, publication status, hashes, or generation/review results.
- Keep dialogue as prose with the project's existing speaker conventions. `CAPTION`, `BALLOON`, page headings, panel numbering, and comic SFX labels belong in a separately requested comic adaptation, not this scene format.
- When revising, change only what the evidence-backed feedback requires and preserve unaffected prose and cues.
- Review cue placement and semantics alongside continuity and approved scope. A cue cannot override a narrative finding.

## Integration Status

- `> Visual:` is consumed by the existing scene-to-image pipeline.
- `> Music:` and `> SFX:` are not yet parsed from inline scene text. Audio production currently uses approved cue specifications from the Project File's Audio Production Brief.
- `> Animation:` is a documented extension; no animation worker/runtime has been selected.

Until those integrations exist and are verified, do not tell the user inline music, SFX, or animation cues were generated, published, or are playable. When implementing execution, update the Writer prompt, presentation validation, reviewer instructions, worker handoffs, README, and this skill together. Existing visual cue documents may be migrated if useful; preserve support for them until the migration is complete.

## Installation

From a checkout of this repository, install globally for Codex with:

```powershell
npx skills@latest add . --skill narration --skill expressive-sounds --agent codex -g -y
```

After this skill is pushed to GitHub's `main` branch, install directly from the repository with:

```powershell
npx skills@latest add https://github.com/DRincs-Productions/LM-Studio --skill narration --skill expressive-sounds --agent codex -g -y
```

To install into other supported agents, replace `--agent codex` with the desired agent ID, or pass multiple agent IDs as supported by the Skills CLI. The format and instructions are portable; references to other Story Skills are optional and apply only when those skills are installed for that agent.
