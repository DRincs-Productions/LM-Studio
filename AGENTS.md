# Repository guidance

## Architecture documentation

For every architectural change in this repository, update the root `README.md` in the same change. Keep its architecture overview aligned with the implementation: revise role descriptions and the diagram when responsibilities or handoffs change. Do not add model names, reviewer details, or low-level implementation specifics to the overview unless the user asks for them.

Before making architectural changes, read the relevant project documentation and preserve existing user work. Keep generated Markdown documentation under `C:\Users\Shadow\.lmstudio`.

## Test workflow

All tests are started and driven from a terminal. Do not use LM Studio/Bionic GUI automation in this repository's test workflow.

There are two test modes:

- **Component:** test one real role/model at a time (Regia, Writer, Designer, or Sound Designer). Use a fresh premise, canon, scenario, and unique run ID for every run. Use the real Project Worker component-test path where applicable so downstream roles can return controlled replies. Regia, Coordinator and Writer tests must not launch downstream production. A Designer test must generate real candidates with Image Worker and review each with Codex. Compare alternative models with the same fresh prompt, canon, scenario, resolution and seed; record selected profile, exact model/encoder/VAE/LoRA paths, MCP calls, generated files, review and outcome in a unique run under `production-tests`. Use Krea2 Turbo for standard non-anime images, RedCraft v3.0 for adult non-anime images, and Krea2 Anime v2.0 whenever Anime style is selected, regardless of content rating. RedCraft is the selected adult standard profile. Do not use the removed SNOFS adapter or include it in new compatibility comparisons. Treat registered LoRAs as optional: select one only when the request explicitly needs its documented effect, check `docs/IMAGE-LORAS.md`, and do not use an adapter in production unless its registry status is `ready`. A LoRA application count of `0 / N` is a failed generation even if the CLI writes a PNG. Do not use ComfyUI as an inference runtime. Preserve rejected and failed candidates in staging. Component comparison images stay in staging and are not finalized or published unless the user explicitly asks. The Sound Designer/audio-generator test is a complete, isolated audio cycle: the fresh test fixture supplies the cue brief, the actual Stable Audio model generates the WAV, Audio Worker inspects it, Qwen performs the local listening review, and Codex acts only as Coordinator to judge the evidence and direct the MCP handoffs. Do not use Codex as the Sound Designer or have it invent the cue. For a passing candidate, record the review, finalize it under `C:\AI\assets\<RUN_ID>\Audio\<Music|SoundEffects>`, publish it under the matching unique run-ID path on `imagecloud:AudioWorker`, and verify the remote WAV and manifest sizes. If review fails or any handoff is uncertain, preserve all evidence and stop before finalization/publication; do not replay generation automatically. Record the seed, fixture, model IDs, MCP calls, output paths, review, local final asset, remote path and result under `production-tests`. Never run game implementation as part of a component test.
- **Complete:** use a fresh disposable Project File and project directory. Run the actual MCP handoffs, production workers and selected Programmer. Regia and Programmer are the only user-facing roles; the terminal harness supplies fresh creative input and explicit test approvals. Inspect physical files and run the generated project's own start/build command. Do not count chat quality as a substitute for checking produced files.

Never reuse a previous test's premise, project folder, output directory or approvals. Include a run ID and a unique input seed in every test manifest. Keep partial outputs and error evidence; do not automatically replay a phase that may already have produced side effects.

### Isolated Writer evaluation

Evaluating a new Writer model requires three separate component-test runs using that exact model profile: `normal`, `hot`, and `violent`. Each run gets a fresh premise, canon, scenario, Project File, seed/run ID, and output directory; do not reuse story facts or drafts across the three. The normal case contains ordinary non-sexual, non-graphic narrative; the hot case is an explicitly consensual erotic scene between clearly adult fictional characters; the violent case is fictional gruesome violence without sexual violence. Assess whether each run follows its own content brief, canon, continuity, tone, and endpoint. Do not use word count or prose polish as pass criteria.

The production narrative path first creates a validated `SceneContract`: Codex and Qwen propose plans in parallel, then Codex merges them and retains authority over the contract and canon. The Writer receives the approved contract and authors the scene. The Narrative Reviewer returns a verdict and localized revision requests; after any revisions, Codex performs the final constraint and continuity check. Invalid contracts stop before Writer generation, and generated prose never updates canon by itself. Isolated Writer component tests exercise the Writer only with controlled simulated revision replies; they must not invoke the real Narrative Reviewer or downstream production. Keep these test results distinct from complete production-pipeline results.

For PaintedFantasy v4.1, first load only the target model from the terminal, then run these independently from `project-worker\mcp`:

```powershell
lms load ms3.2-paintedfantasy-v4.1-24b --identifier writer-paintedfantasy-test --context-length 8192 --gpu 0.85 --parallel 1 --yes
npm run test:component -- --role writer --writer-profile paintedfantasy --writer-case normal
npm run test:component -- --role writer --writer-profile paintedfantasy --writer-case hot
npm run test:component -- --role writer --writer-profile paintedfantasy --writer-case violent
```

Run the three commands once each, sequentially. The runner records the exact model profile and settings, Project Worker calls, prompts and drafts under a unique `production-tests\components` run. It uses a controlled simulated revision request; do not start the real Narrative Reviewer, downstream production, asset creation, finalization, or publication. Preserve failed or partial runs and stop rather than automatically replaying an uncertain generation. A failed or incomplete run in one content category does not authorize skipping or merging the other category runs.

## Where to change the pipeline

- MCP server entrypoints and their package manifests are in `project-worker/mcp`, `image-worker/mcp`, `asset-worker/mcp` and `audio/mcp`. Coordinator orchestration and Project Worker tool contracts are under `project-worker/mcp/orchestration`.
- Model system prompts and load/prediction settings are in `apps/bionic/.internal/user-concrete-model-default-config`. Preserve each model's exact config filename and model path association.
- Bionic's MCP registration is in `apps/bionic/.internal/ng-mcp.json`; Codex's server registrations are in the user's Codex configuration. Do not rewrite either registration wholesale. Update paths and tool allowlists surgically and only when the code/config change requires it.
- For any change to role ownership, handoff, project paths or test workflow, update the root `README.md` in the same change. Keep this file current with actual commands and test outcomes.

## Test safety and reporting

Use unique temporary roots for full tests and unique run IDs for component tests. Allow writes only beneath the run root and configured worker staging roots; the Sound Designer component test may additionally finalize beneath `C:\AI\assets\<RUN_ID>` and publish beneath the matching unique remote run-ID directory only after a passing review and explicit test authorization. Never overwrite or delete existing assets, remote files, older test artifacts, Bionic SQLite databases, the installed Bionic bundle, credentials, or existing project files. Report which test mode ran, exact commands, model and MCP availability, verified local and remote outputs, failures and any unrun stage. Do not claim completion based on a queued job or a model response alone: verify the generated file, its technical properties, hash-matched listening evidence, final manifest, and remote publication sizes.


## Codex and Bionic entrypoints

Codex uses normal GPT conversation by default. Only on an explicit human request to speak with local Regia, use Project Worker start_regia_session and talk_to_regia; retain the project session across turns and display its reply verbatim, attributed to Regia. "Torna a Codex" suspends the relay with stop_regia_session and preserves history. On a resumed task, inspect get_regia_session for the intended canonical project before deciding which mode is active. If the request is unrelated to the creative conversation, handle it directly rather than automatically forwarding it.

Use the bionic-regia-orchestration skill for detailed routing, canonical-file persistence, approval and recovery rules. Proposed documents must be saved/read back via Project Worker before claiming success. No model message can approve production. Codex-origin production uses frontend="codex" and a verified relay; Bionic-origin handoff retains frontend="bionic" and its original binding verification. Never copy a canonical file to hide a mismatch between client workspace roots.

### Isolated Planner evaluation

Run `npm run test:planner` once from `project-worker\mcp`. The component runner creates a fresh run ID and independent fixtures, obtains Codex and Qwen proposals in parallel, and has Codex merge them into validated SceneContracts. It records prompts, model/config identifiers, proposals, merged contracts, hashes and outcomes under `production-tests\components`. It must not invoke Writer, production, asset creation, finalization or publication. Preserve partial evidence and do not replay uncertain model calls. Record the blind paired comparison and selected planner arrangement in the run report.

