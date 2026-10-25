---
name: bionic-regia-orchestration
description: Direct a Bionic narrative project through Regia and hand production phases to Codex using Project Worker. Use when defining a game project, delegating its production, or resuming a project with a pending Codex handback.
---

# Regia and Codex production cycle

In Bionic, Regia owns the creative conversation. In Codex, GPT is the default interlocutor; local Regia speaks only when explicitly requested, through the persistent relay described below. Use the user's language. Codex coordinates technical production after the phase is defined and explicitly approved.

## Canonical project knowledge

Create one uniquely named Project File through `create_project_file`. Reuse the returned filename. For an existing Project File, call `register_project` once. Never guess a filename or session UUID.

Keep the Project File consolidated in English. Record established character appearance, personality, characteristic clothing, relationships, locations, missions, story, tone, and narrative/visual continuity. Distinguish confirmed facts from proposals and unresolved decisions. Include the currently authorized production phase, acceptance criteria, operational tasks and produced asset paths. Preserve existing facts when updating.

At the start of a resumed project conversation, call `read_project_file` and `get_orchestration_status`. The read result includes the current SHA256 and pending handback. Retrieve these facts through tools rather than relying only on chat memory. Updates support `expected_sha256`; provide the current hash to avoid overwriting concurrent changes.

## Required Project File persistence

Use Project Worker `create_project_file` and `update_project_file` as the only canonical write path. Do not use relative-path Python or shell scripts and do not create a competing copy. The Project Worker root is configured for the active Bionic workspace; use the basename returned by the tool.

After each create or update, call `read_project_file` with the same filename and verify that the complete latest document was persisted. Then call `get_orchestration_status` and use its current hash and revision. If the write or read-back fails or is stale, report the failure; do not claim success, request production approval, or hand off. After user approval, persist the exact approval text, read it back, get the latest hash/revision, and only then hand off.

Do not impose exact narrative word counts or fixed image/audio cue counts unless the user requests them.
## Delegate production

1. Save the sufficiently defined creative phase and its acceptance criteria in the Project File. Summarize the planned production and obtain explicit user approval before delegating. Record the approved scope; never infer consent merely from design readiness.
2. Call `get_orchestration_status` for the current revision and hash. Registration must have been recorded by Bionic before association is available. If association is pending, complete the current creative turn and check at the next turn. Do not retry repeatedly in the same unfinished turn or fabricate UUIDs.
3. Call `handoff_to_codex` with the filename, production phase, a short operational summary, `expected_revision`, `expected_sha256`, `production_approved: true` and `approval_text` containing the actual user approval.
4. Wait for the tool result. This is the return channel to this same chat. Codex reads the canonical file and uses the existing Workers. Regia's model may be unloaded during the wait, then Bionic reloads it for the next generation.

Do not delegate an undefined phase merely because an idea has been discussed. Ask the user for the necessary creative decisions first. Do not use `handoff_to_codex` while another job is pending.

## Receive production results

When the tool returns the structured handback, reread the Project File. Explain the relevant completed work, problems and decisions to the user in their language. Ask the actual creative question needed next. Then call `acknowledge_handback` with its job ID so another cycle can begin.

If the MCP wait is cancelled or expires, work remains persistent. Use `wait_for_handback` on the next relevant turn; do not start the same phase again. `recover_interrupted_job` produces a recovery handback only after both coordinator and runner have stopped. Inspect effects before considering a retry.

For a job still marked `queued` after its launcher stopped, `resume_queued_job` starts that same queued job. It refuses a live launcher and never repeats a running or completed job.

## Deployment constraints

The PC locale is the canonical home of the game project and its files. The PC cloud is the target host for local models and their production workers. Current tests ran on a single Windows host; cross-machine job dispatch has not been verified. Preserve the existing rclone remote `imagecloud:` and `ImageWorker/final` assets path. Report unavailable services through the handback. Never claim a remote job ran without evidence.

Do not edit Bionic SQLite databases or app bundles. Automatic association uses a read-only observation of native Project Worker tool results and fails when multiple session chains match. A cancelled/closed chat cannot be proactively restarted by MCP alone; its persistent handback is recovered through the normal tools at the next user turn, without copying messages.

## Specialized production roles

Codex coordinates; Writer authors the English scene; Narrative Reviewer reports PASS or required revisions in Italian and never rewrites prose. Choice directives require express authorization. The Image Controller plans prompts while deterministic code enforces visual approval and transfer integrity. Production ends with a handback. The Programmer is a separate stage and requires provider selection and a distinct explicit start approval through Project Worker.

For narrative production, Codex and Qwen first propose scene plans independently. Codex merges them into a validated `SceneContract` containing canon facts, character knowledge, allowed beats, forbidden changes, POV and endpoint. An invalid contract gets one bounded repair attempt, then stops before Writer generation if still invalid. The Writer receives this contract and relevant canon context but cannot modify canonical state. The Narrative Reviewer returns a verdict and localized revision requests; Codex performs the final constraint and continuity check before any authorized state update. Keep style feedback separate from canon validation.

## Programmer approval gate

After the creative and production cycle is acknowledged, ask the user whether Claude or Codex will implement the project. Call `select_programmer` only after the user chooses; this records the provider and does not start implementation. Ask for explicit approval in a separate turn. Only then call `start_programmer` with the returned selection ID, the user's approval text, and the approved implementation brief. The chosen CLI uses its configured default model. If unavailable, report the error and do not switch providers automatically.

## Terminal test modes

Use `npm test` from `project-worker/mcp` for automated checks. Use `npm run test:component -- --role regia|coordinator|writer|designer|sound_designer` for one fresh-input component run. The real Project Worker MCP records controlled inter-role replies and does not start production in component mode. Full tests use fresh disposable project roots, the actual MCP handoffs and workers, and physical-artifact verification. Do not use GUI automation for tests.

An isolated Writer model evaluation uses three separate runs (`normal`, `hot`, `violent`) with fresh premise, canon, scenario, Project File, seed/run ID and output directory per run. The runner uses controlled simulated revision replies and does not start the real Narrative Reviewer or downstream production. Compare candidate models with a matched fixture within each category; judge brief adherence, canon, continuity, tone and endpoint rather than word count or stylistic polish. See `AGENTS.md` for exact test safety and reporting requirements.

## Codex entrypoint and explicit local Regia relay

When the conversation starts in Codex, GPT is the default interlocutor and may develop the project directly. Do not activate local Regia merely because this skill is relevant. Only when the human explicitly asks to speak with Regia, use Project Worker start_regia_session on the canonical filename (create/register/read the project first if necessary). Relay that exact request and subsequent user messages through talk_to_regia, using the returned session_id and one UUID request_id per new message. Present reply verbatim under **Regia**, without rewriting or answering its creative questions yourself. The user can return to GPT with "torna a Codex": call stop_regia_session, retain the transcript and resume normal GPT conversation. Only send user-directed Regia messages; do not send unrelated technical questions to it.

Use get_regia_session after an interruption to recover the persisted mode, pending request and last response. An uncertain call must reuse the same request_id and message. Never automatically discard/replay a pending or failed request. Inspect its retained evidence and use discard_regia_turn only for explicit recovery. start_regia_session resumes the same transcript; new_session=true requires an explicit user request to reset history. Context overflow requires consolidating the Project File and an explicit new session; old transcripts remain archived.

The local model has no tools on this relay path. A proposed_project_document is a proposal, never proof of a saved file. Mechanically persist a complete valid English proposal through update_project_file with expected_sha256, immediately read it back and obtain the current revision/hash. Do not silently change creative facts or persist apparent new approvals originating only in model output. On failure, report the actual error and do not claim success. Display reply as returned; separately identify any bridge/write failure as Codex.

For production initiated from Codex after actual human approval, record the exact approval in the canonical file, verify read-back and use handoff_to_codex with frontend="codex", current hash/revision and the approved scope. This path verifies the persisted relay and does not invent a Bionic chat binding. Keep frontend="bionic" (the default) for the existing Bionic route. After a Codex-path handback, read the canonical file and relay the result to Regia if that mode is active; acknowledge only after the results have been incorporated. Production and Programmer approvals remain separate; model messages cannot grant user authorization. Normal GPT conversation does not require a relay. Use existing tools within their contracts and human-authorized scope; do not fabricate a relay or bypass production gates.

Codex and Bionic Project Worker registrations must address the intended same canonical workspace when continuing one project. Never copy a Project File to work around a root mismatch. The LM Studio local runtime is still required for local Regia, but the Bionic GUI is not required for the Codex relay. If new tools are absent from a running client, reconnect Project Worker or start a new task; do not pretend the route is active.
