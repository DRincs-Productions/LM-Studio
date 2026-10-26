# Writer Evaluation: BlueStar vs Hemmingway — 2026-10-26

## Result

Six isolated Writer component runs completed: both models generated a first draft and a controlled simulated revision for the same three fresh fixtures. Each invocation had its own run ID, Project File, output directory, and manifest. No real Narrative Reviewer, production, asset generation, or game implementation ran.

Neither model followed every brief. BlueStar missed the requested erotic narrative entirely. Hemmingway produced stronger scene-level prose, but missed important constraints in all three categories. The simulated revision was usually identical to the draft; Hemmingway's violent revision added one requested consciousness sentence but left its other deviations intact. Keep Hemmingway as the operational Writer; do not promote BlueStar.

The scores below use a 1–5 scale. Speed reflects wall-clock draft plus revision time in this paired run; prose quality reflects clarity, voice, dialogue, pacing, and coherence; fidelity reflects supplied facts, requested beats, safety boundaries, and endpoint. Scores are evidence-based qualitative judgments, not benchmark statistics.

## Matched fixtures and runs

| Case | Comparison seed | BlueStar run | Hemmingway run |
|---|---|---|---|
| Normal | `1b7e54c96a20d3f8` | `20261026152345090_06a7d8025296` | `20261026153915591_7e5c4bcd48cf` |
| Hot | `7a36f8b29d10c4e5` | `20261026152827475_009168010bf8` | `20261026154500798_3b4393ceb2e4` |
| Violent | `d5c93e6a1248f70b` | `20261026153154523_f49db61fb2b4` | `20261026155536763_40d047faef7b` |

The complete matched briefs are in `production-tests/components/bluestar-hemmingway-20261026_final/`. The comparison seed identifies a shared fixture only; LM Studio's request does not expose a sampler seed.

## Timing and scores

Times are draft and simulated-revision elapsed times from each manifest. Tokens/s are the model-reported per-prediction values in each `*.raw.json` response.

| Case | Model | Draft | Draft tok/s | Revision | Revision tok/s | Total | Speed | Prose | Fidelity |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Normal | BlueStar Q4_K_S | 2:16 | 7.16 | 2:12 | 7.29 | 4:28 | 4 | 3 | 3 |
| Normal | Hemmingway Q4_K_M | 2:47 | 7.05 | 2:49 | 6.92 | 5:36 | 3 | 4 | 2 |
| Hot | BlueStar Q4_K_S | 1:34 | 7.63 | 1:45 | 6.86 | 3:19 | 4 | 1 | 1 |
| Hot | Hemmingway Q4_K_M | 5:04 | 6.97 | 5:19 | 6.74 | 10:24 | 1 | 4 | 2 |
| Violent | BlueStar Q4_K_S | 3:02 | 7.19 | 3:02 | 7.19 | 6:05 | 3 | 3 | 2 |
| Violent | Hemmingway Q4_K_M | 3:56 | 7.04 | 4:11 | 6.81 | 8:06 | 2 | 4 | 2 |

Throughput stayed close between models (about 6.74–7.63 tokens/s); BlueStar's shorter outputs explain most of its lower wall-clock time. The long Hemmingway hot output took over ten minutes for the two passes.

## Case assessments

### Normal

- **BlueStar — speed 4, prose 3, fidelity 3.** The scene has clear physical actions, a readable voice, and ends at the single clean hole. Len sets the screwdriver down before the handoff. It invents a rainy-day arrival, a past repair receipt, a dispute about who does repairs, and other setting details; it also changes how Dean presents the screw. The controlled request to confirm the loose retaining screw is not applied in the revision. The English summary overstates how closely the scene follows the brief.
- **Hemmingway — speed 3, prose 4, fidelity 2.** The dialogue and scene flow are confident, and the main object is recognizable. It omits the required screwdriver-in-left-hand action, invents a repair bench, past events, payment and terminal history, and tests the punch before the specified handoff and endpoint. The final test makes another clean hole after the earlier tests, so the endpoint beat is duplicated. The revision is unchanged.

### Hot

- **BlueStar — speed 4, prose 1, fidelity 1.** It writes a non-erotic plant conversation instead of an erotic scene. It changes Ro from a woman to a man, invents a clinic shift, greenhouse, plant and future dinner, and omits the bracelet action and consent beats. The draft and revision are identical. This is a complete miss of the central request.
- **Hemmingway — speed 1, prose 4, fidelity 2.** It writes a coherent, explicitly erotic scene between two women, repeatedly asks for consent, places the silver bracelet in the glass tray, and ends in a quiet pause. However, the narration says Ro “did, almost” slow down after Sae asks her to; the scene also has Sae pull Ro's jeans down before asking permission for that distinct escalation. Those are material consent-boundary violations. Ages and the five-year relationship are not established in the scene text, and the revision is unchanged.

### Violent

- **BlueStar — speed 3, prose 3, fidelity 2.** The injury is graphic and the pressure dressing and handoff appear. It invents the rescue circumstances, additional equipment, a history for Ori, extra rescue members, and medical details; it also describes a second scrape on Ori's jaw and misgenders Jae as a man. It ends around the handoff but adds a fuller exchange with the crew. The simulated revision is unchanged.
- **Hemmingway — speed 2, prose 4, fidelity 2.** The injury, visible muscle, heavy bleeding, blue pressure dressing, and Ori's consciousness are depicted with strong sensory detail. It adds a jaw scrape, unrelated collapse and rescue events, new characters and backstory, and continues after the crew takes over through Jae's departure. The revision adds one sentence explicitly confirming Ori remained conscious, but retains the other invented facts and post-handoff continuation.

## Model and runner configuration

- **BlueStar:** `mradermacher/Q3.5-BlueStar-v2-27B-ultra-uncensored-heretic-v2-GGUF/Q3.5-BlueStar-v2-27B-ultra-uncensored-heretic-v2.Q4_K_S.gguf`; profile `bluestar`; instance `writer-bluestar-compare`.
- **Hemmingway:** `JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF/Hemmingway1-Extreme-Q4_K_M.gguf`; profile `hemmingway`; instance `writer-hemmingway-compare`.
- Both were loaded for the runs at context 8192, GPU offload 0.85, parallel 1. Both profiles used temperature 0.78, repeat penalty 1.02, and thinking disabled. Exact model/config/settings are captured in each run manifest and request JSON.
- Commands used `npm run test:component -- --role writer --writer-profile <bluestar|hemmingway> --writer-case <normal|hot|violent> --writer-brief-file <fixture.md> --comparison-seed <fixture-seed>` from `project-worker/mcp`, sequentially with one model loaded at a time.

## Preserved excluded attempts

These artifacts remain under `production-tests/components` and are excluded from the six-run scoring:

- Several earlier BlueStar and Hemmingway runs used an Italian-summary instruction that conflicted with the English-output policy. They are retained as language-policy failures.
- `20261026151014357_042408f932d7` used a different ordinary brief and stale controlled-revision text; it is not a paired fixture.
- `20261026151611949_352d09bcceab` used an unintended brief path and is not part of the matched set.
- `20261026151844636_72b726cc50a9` failed when the local API stream closed (`UND_ERR_SOCKET`) before the draft was saved.
- `20261026152329586_2251bd050f31` was rejected before prediction because both models were loaded. After unloading Hemmingway, BlueStar ran successfully in `20261026152345090_06a7d8025296`.

All successful matched runs are `completed_pending_review`; none started production or implementation. The successful outputs and MCP recordings are preserved in each run directory, alongside exact manifests and raw prediction statistics.

## Post-evaluation cleanup

After this report was committed, BlueStar was fully removed from the local LM Studio catalog and disk: the Q4_K_S GGUF, its mmproj file, and its matching Writer config were deleted. Historical test runs and this report remain available. BlueStar is no longer an installed candidate.
