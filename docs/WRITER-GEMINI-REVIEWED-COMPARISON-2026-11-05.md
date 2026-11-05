# Hemmingway–Magidonia comparison with Gemini review — 5 November 2026

## Scope and setup

This isolated Writer comparison used one fresh, matched, non-graphic intimacy fixture (`6b2e945c01ab7d43`). Both models received the same English brief, canon, required beat order, word range, consent boundaries and endpoint. Each Writer draft and revision used its own run ID, output directory, manifest and Project Worker Project File. No production, asset generation, publication or game implementation ran.

The fixture describes two sober fictional adults in an established relationship in a coastal cabin. It asks for sensual but non-graphic intimacy and an exact fade-to-black decision endpoint. It requires a hesitation, a direct conversation about readiness, removal of a silver ring from the right hand to the windowsill before the first kiss, consent before escalating touch, a reciprocal check-in, and 500–700 words in `## Narrative`.

| Model | Installed quantization | Bionic profile | Sampling profile | Runtime load |
|---|---|---|---|---|
| Hemmingway1 Extreme | Q4_K_M, about 16.55 GB | `apps/bionic/.internal/user-concrete-model-default-config/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF/Hemmingway1-Extreme-Q4_K_M.gguf.json` | temperature 0.78, repeat penalty 1.02, thinking off | context 8192, GPU offload 0.85, parallel 1 |
| Magidonia 24B v4.3 | Q4_K_M, about 14.33 GB | `apps/bionic/.internal/user-concrete-model-default-config/bartowski/TheDrummer_Magidonia-24B-v4.3-GGUF/TheDrummer_Magidonia-24B-v4.3-Q4_K_M.gguf.json` | temperature 0.8, repeat penalty 1.05, min-p 0.025 | context 8192, GPU offload 0.85, parallel 1 |

The saved raw requests confirm each model received its selected Bionic system prompt, including the current narration skill reference and embedded NCF constants. Runtime load settings were matched; model-specific sampler settings were not normalized, so some speed and prose differences may reflect those profiles. The [Hemmingway GGUF card](https://huggingface.co/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF) describes the selected Q4_K_M variant; the [Magidonia model card](https://huggingface.co/TheDrummer/Magidonia-24B-v4.3) identifies its Mistral/Tekken lineage and roleplay focus.

Gemini CLI 0.66.0 acted as the initial Reviewer using model alias `auto`. Its review instructions applied the relevant criteria from the installed `scene-craft`, `revision-continuity`, and `line-editing` skills: scene progression, exact canon and endpoint checks, and evidence-based local edits that preserve voice. Those criteria were supplied directly in the later review prompt after Gemini's initial attempts to read skill files failed. The CLI reported the three skill names as applied; the skill-file reads themselves were not verified as successful.

## Results

| Model | Draft time | Gemini initial review | Revision time | Harness/MCP overhead | Time to revised final text | Narrative words | Draft / revision tok/s | Gemini initial prose / constraints | Final Codex prose / constraints |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Hemmingway | 2:34 | 0:46 | 2:36 | 0:00 | **5:56** | 683 | 7.52 / 7.30 | 4 / 4 | **4 / 3** |
| Magidonia | 1:43 | 0:51 | 3:21 | 1:29 | **7:24** | 1,037 | 8.46 / 7.67 | 4 / 2 | **3 / 2** |

“Time to revised final text” includes the first draft, Gemini's completed initial review and one Writer revision. It excludes the later Gemini post-revision check, which did not finish. Hemmingway's post-revision review timed out at 10 minutes; Magidonia's timed out at 4 minutes. These failures and logs are preserved and are not included in the completion-time figures. The CLI Auto route encountered a Gemini Pro API error; the initial Magidonia review eventually returned after 182 failed Flash API requests and one successful request. This is a reliability concern for using the current Gemini CLI as a blocking review gate.

### Hemmingway

Gemini identified a real coat-continuity contradiction and asked for one local correction. Hemmingway removed the sentence that had already taken the coat off, so Elise's later action no longer contradicted it. The final scene meets the 500–700 word range, places the ring before the first kiss, asks and answers consent before touch escalates, and ends on the couple's clear decision to continue.

The prose is the stronger of this pair: it is atmospheric, has a clear emotional hesitation and a restrained pace. It repeats the consent question motif several times, but mostly uses that repetition to characterize the couple. It invents unsupported details, including the ring's origin in Mara's mother's drawer and a peppermint taste from an earlier trail. Its Visual cue also assigns the characters a gender and appearance not specified by the fixture. Gemini's initial high constraint score did not catch these additions.

**Final assessment:** prose 4/5; constraint fidelity 3/5. The required sequence and endpoint hold, but unsupported background details remain.

### Magidonia

Gemini's initial review correctly found that the draft stopped before the required kiss and reciprocal consent checks, that the summary claimed beats absent from the prose, and that “river water” conflicted with the coastal/tidal setting. One Writer revision added the missing kiss and explicit consent exchanges and changed the water detail.

The revised prose has vivid weather and differentiated dialogue, but it is 1,037 words—337 words over the fixture's maximum. It adds an unsupported history on the beach and a near-drowning/tidal event, then continues beyond the required endpoint with another exchange and the start of removing Mara's shirt. The summary says the scene fades to black although the narrative does not reach that point. The revision fixes the review's targeted gaps but introduces or retains major scope and endpoint violations.

**Final assessment:** prose 3/5; constraint fidelity 2/5. The required consent sequence is now present, but the length, invented backstory and endpoint failures remain.

## Comparison and reviewer finding

Hemmingway reached the revised text **1 minute 28 seconds sooner**. Magidonia generated tokens faster in both calls, but its revision was longer and slower overall. Hemmingway is the better result for this fixture on both prose and constraint fidelity. This single matched sample does not establish a general model ranking.

Gemini was useful on the initial pass: it found Hemmingway's coat contradiction and Magidonia's missing consent beats. It did not reliably judge the finished result. Its initial Hemmingway score overlooked invented facts, and the post-revision review timed out for both models. Codex's final checks therefore supply the reported final scores. Gemini should remain an experimental reviewer rather than a required release gate until its API retries and post-revision behavior are more dependable.

Each model received one Writer revision. Hemmingway received one correction request. Magidonia received three correction requests in the same revision. The five-change maximum was not exceeded.

## Run evidence

- Hemmingway chain: `production-tests/gemini-reviewed-comparison/hemmingway-20261105185130442_2b75e43b4a61/`
  - Draft run: `20261105185130447_af08e73e7a53`
  - Revision run: `20261105185451153_5334b3e8e96b`
  - Gemini review runs: `20261105185405385_c0a2c21b6815` (completed), `20261105185727740_d7b94a9ff374` (timed out)
- Magidonia chain: `production-tests/gemini-reviewed-comparison/magidonia-20261105191152180_fe54afc0e6e9/`
  - Draft run: `20261105191152228_45625fef5faf`
  - Revision run: `20261105191555083_f4d3d2d351db`
  - Gemini review runs: `20261105191335776_4e8e315469ea` (completed), `20261105191916585_f83e0a0a4448` (timed out)

The run folders preserve the shared fixture, final text, prompts, raw local-model requests and responses, settings snapshots, Gemini CLI output, Project Worker MCP records and manifests. No model files were removed.
