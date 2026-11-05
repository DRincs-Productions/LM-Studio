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

## Scene Artifact

Use this Markdown envelope:

```markdown
# Scene: <title>

## Narrative
<prose, dialogue, and optional NCF cue lines>

## English Summary
<short production summary>
```

Project artifacts, including narrative, dialogue, cues, and summaries, are in English. Put each cue on its own line at the point it applies. Keep story information in the prose; cues enrich presentation and must not carry plot facts omitted from the scene.

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

### Combined example

```markdown
# Scene: The Greenhouse Signal

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
- Add only cues supported by the approved brief or Project File. In particular, do not add music or SFX just to make a scene feel cinematic.
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
npx skills@latest add . --skill narration --agent codex -g -y
```

After this skill is pushed to GitHub's `main` branch, install directly from the repository with:

```powershell
npx skills@latest add https://github.com/DRincs-Productions/LM-Studio/tree/main/skills/narration --agent codex -g -y
```

To install into other supported agents, replace `--agent codex` with the desired agent ID, or pass multiple agent IDs as supported by the Skills CLI. The format and instructions are portable; references to other Story Skills are optional and apply only when those skills are installed for that agent.
