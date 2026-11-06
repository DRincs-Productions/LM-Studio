# Handoff 08 — Remote narration through Shadow Controller

## 1. Generic Codex connection

Continue the connection already started. The server accepts authenticated typed operations, validates input against the operation schema and enqueues by account and request ID. Dispatch one job at a time to server-side Codex, wait for the verified outcome, and move the job out of the active queue while retaining its terminal record. Use server-owned prompts, allowlisted tools and a bounded runtime. Cancellation and restart must preserve evidence and clean up only owned processes and model instances. An uncertain attempt must not replay automatically.

## 2. Server narration skill

Create a self-contained skill under `skills/shadow-narration-coordinator` during implementation. Embed the operational steps and output rules in the skill. Codex first plans against the approved brief and pinned canon. Prefer a focused Qwen consultation on specific violent or intimate beats over a second full plan. Give Qwen advice weight in those beats when it fits canon, consent and scope. Codex resolves disagreements and authors the sole validated SceneContract.

The installed Qwen3.5 27B Writer V2 Uncensored Heretic Q4_K_S is a candidate for an isolated consultation evaluation. Its existing configuration is a Writer profile. Inspect the actual prompt and runtime before selecting it, and evaluate a separate consultation profile without altering the Writer profile. Keep consultation optional until it demonstrates value.

Send the approved contract and operative NCF instructions from the narration skill to Hemmingway. Run Gemini Auto for at most five review submissions, using the narration, scene craft, continuity and line editing criteria. Codex makes the final canon and presentation check. Project Worker saves the English scene with inline cues and verifies its hash. Reuse deterministic MCP tools for validation, model execution, review evidence and finalization to limit repeated context and token use.

## 3. Narration operation

Register `narrative.generate` v1 explicitly. Resolve the project within the authenticated account, pin and recheck its canonical hash, and pass the approved brief as data. Treat optional metadata as descriptive. Return the verified scene and hash via the relay, with bounded retrieval for content larger than the relay envelope. Return prose and cue descriptions only. Asset production is an independent client decision.

## 4. Client activation and acceptance

After a real relay run from an enrolled client verifies completion and byte-identical retrieval, enable `@shadow-narration` through the client plugin. Verify duplicate submission, stale canon, cancellation, restart and retrieval after reconnect. Preserve evidence from the previous successful narration cycle and consolidate that path. The prior cycle does not establish that cross-PC relay delivery works.

### Resource lifecycle

Keep the same Qwen instance loaded across consultation turns. Unload that instance and verify its removal before loading the Writer. Before returning the result to the Coordinator, stop any remaining job-owned Gemini processes and unload any remaining job-owned local models. Apply the same cleanup on failure and cancellation. Block further dispatch if cleanup cannot be verified. Prefer MCP tools for the consultation session and deterministic lifecycle checks. Audit existing tools and callers before removing any obsolete entry.
