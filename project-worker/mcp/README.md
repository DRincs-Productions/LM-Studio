# Project Worker MCP

Project Worker exposes the narrative project's roles and orchestration through MCP. Regia and the Coordinator govern the project; the Writer drafts prose; the Narrative Reviewer checks scenes and may request localized corrections. The Writer does not directly modify the Project File or canon.

## Narrative workflow

1. OpenCode using `openai/gpt-6-luna` proposes a `SceneContract` from the approved brief and Project File.
2. The same OpenCode planner validates and merges the proposal against the authoritative source, then performs one bounded schema repair if needed. Invalid contracts stop before Writer generation.
3. The Writer receives the contract and relevant canon, then drafts the scene.
4. OpenCode runs the text-only Gemini Narrative Reviewer, which returns a verdict and, when needed, bounded revision requests.
5. After revisions, OpenCode using `openai/gpt-6-luna` directly edits and verifies the final scene. Canon changes require separate authorization; generated prose never updates canon automatically.

Planning and constraint checks do not replace the Reviewer's stylistic judgment. Unknown facts remain unknown and do not authorize the Writer to invent them. For architecture and current status, see the [root README](../../README.md) and the [narrative model comparison](../../docs/CONFRONTO-MODELLI-NARRAZIONE.md).

## Commands

Run commands from this directory:

```powershell
npm test
npm run test:planner
npm run test:component -- --role writer --writer-profile <profile> --writer-case normal
npm run test:component -- --role writer --writer-profile <profile> --writer-case hot
npm run test:component -- --role writer --writer-profile <profile> --writer-case violent
```

Isolated Writer evaluations require three independent runs (`normal`, `hot`, `violent`), each with a fresh fixture, Project File, seed, run ID, and output directory. The runner uses simulated revision replies; it does not start the real Narrative Reviewer or production. Model comparisons use the same fixture for each matched pair. Evaluate the request, canon, continuity, tone, and endpoint; word count and surface polish alone are not pass criteria.

Planner tests are isolated: they record the proposal, merge, and contract validation without invoking Writer, asset creation, or publication. Each run stores a manifest and evidence under `production-tests/components`; preserve partial runs and do not automatically replay uncertain model calls. Full guidance is in [AGENTS.md](../../AGENTS.md).
