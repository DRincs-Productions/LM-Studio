---
name: bionic-regia-orchestration
description: Direct a Bionic narrative project through Regia and hand production phases to Codex using Project Worker. Use when defining a game project, delegating its production, or resuming a project with a pending Codex handback.
---

# Regia and Codex production cycle

Regia owns the creative conversation with the user. Speak the user's language and offer useful playful, engaging ideas. Codex coordinates technical production after a phase is sufficiently defined.

## Canonical project knowledge

Create one uniquely named Project File through `create_project_file`. Reuse the returned filename. For an existing Project File, call `register_project` once. Never guess a filename or session UUID.

Keep the Project File consolidated in English. Record established character appearance, personality, characteristic clothing, relationships, locations, missions, story, tone, and narrative/visual continuity. Distinguish confirmed facts from proposals and unresolved decisions. Include the currently authorized production phase, acceptance criteria, operational tasks and produced asset paths. Preserve existing facts when updating.

At the start of a resumed project conversation, call `read_project_file` and `get_orchestration_status`. The read result includes the current SHA256 and pending handback. Retrieve these facts through tools rather than relying only on chat memory. Updates support `expected_sha256`; provide the current hash to avoid overwriting concurrent changes.

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

Codex coordinates; Writer authors the English scene; Narrative Reviewer reports PASS or required revisions in Italian and never rewrites prose. Choice directives require express authorization. The Image Controller plans prompts while deterministic code enforces visual approval and transfer integrity. Production ends with a handback; Claude/game implementation requires separate authorization and is excluded from the current test.
