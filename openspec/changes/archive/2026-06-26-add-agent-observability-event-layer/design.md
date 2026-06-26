## Context

The project already has a durable goal timeline, a backend event publisher, and an SSE stream that pushes newly persisted events to the dashboard. That transport works, but the provider side still behaves like a black box for Codex Local runs: the dashboard may see little or no progress until the Codex process exits, and a timeout can leave the user unable to tell whether the agent was thinking, executing a command, blocked by sandboxing, or idle.

The longer-term product direction needs stronger observability because the runtime will eventually have a main agent that plans work and delegates tasks to subagents. Users should be able to follow the process at a semantic level without reading raw terminal logs or exposing provider credentials.

## Goals / Non-Goals

**Goals:**

- Define a provider-agnostic set of durable observability events for agent liveness, provider progress, command execution, subtask progress, and future parent/child agent relationships.
- Keep the existing durable event plus SSE path as the only dashboard stream.
- Add enough metadata to each observability event to identify provider, model, agent role, agent id, optional parent agent id, optional task id, and provider event provenance.
- Extend Codex Local to prefer `codex exec --json` and map JSONL events into the observability layer.
- Preserve the final provider result/error behavior expected by provider-backed runs.
- Sanitize all provider output before persistence and streaming.
- Split implementation so this change can be completed before full main-agent/subagent orchestration exists.

**Non-Goals:**

- Do not make the dashboard attach directly to provider stdout or stderr.
- Do not display unsanitized raw terminal output by default.
- Do not implement a full subagent scheduler, distributed worker pool, or multi-user fan-out in this change.
- Do not add new credential storage or dashboard-side provider execution.
- Do not require every provider to emit the same rich event stream immediately; providers may emit best-effort observability.

## Decisions

1. Use durable events as the observability boundary.

   Provider adapters will emit structured progress to the runtime, and the runtime will persist those observations before they are published through the existing SSE stream. This preserves refresh/reconnect behavior and keeps dashboard semantics aligned with the durable timeline.

   Alternative considered: connect the dashboard directly to provider stdout. That would reduce backend work, but it would lose events on refresh, bypass sanitization, couple the UI to each provider's process behavior, and make future subagent observability harder to reason about.

2. Add a typed provider progress callback instead of only raw string chunks.

   The provider contract should grow from `onProgress(chunk: string)` to a callback that can accept structured observations such as heartbeat, output summary, command started, command completed, command failed, subtask started, and subtask completed. A compatibility path can still map plain stdout/stderr text into output-summary observations.

   Alternative considered: keep only string chunks and infer semantics later. That keeps the interface small but throws away command ids, event types, and parent/child context that Codex JSONL already exposes.

3. Prefer Codex JSONL for Codex Local observability.

   Codex Local should prefer `codex exec --json` when the installed CLI supports it. JSONL output can expose item lifecycle events, command execution events, agent messages, errors, and turn failures. The adapter will parse each JSON object incrementally, map recognized events into safe provider progress observations, and still produce one final provider response.

   Alternative considered: continue using only `--output-last-message` plus stdout. That is simpler but does not reliably prove liveness or show what Codex is doing while a run is active.

4. Preserve final response behavior with a staged migration.

   The first implementation may keep `--output-last-message` while also enabling `--json` if the CLI permits both. If the CLI cannot combine them reliably, the adapter should extract the final agent message from JSONL and fall back to the existing last-message file path only when JSONL is unavailable or disabled by capability detection.

   Alternative considered: switch fully to JSONL in one step. That is cleaner long term, but a staged path reduces the chance of breaking provider-backed final result behavior.

5. Use semantic event types with future subagent metadata.

   The durable timeline should include new event types or event data that can represent `agent.heartbeat`, `agent.progress`, `agent.command.started`, `agent.command.completed`, `agent.command.failed`, `agent.subtask.started`, `agent.subtask.completed`, `agent.subtask.failed`, and agent run lifecycle observations. Event data should include safe metadata fields such as `agentId`, `agentRole`, `parentAgentId`, `taskId`, `provider`, `model`, `source`, and `rawEventType`.

   Alternative considered: store all observations as `agent.progress`. That minimizes domain changes but makes the dashboard and future orchestration code parse messages to understand state.

6. Keep the dashboard initially simple.

   The first UI pass can render observability events in the existing timeline with clearer labels and provider/model metadata. A later UI change can group events by agent/task, collapse heartbeat noise, and add richer command detail views.

   Alternative considered: build a full multi-agent tree UI immediately. That would be premature before the orchestration layer exists.

## Risks / Trade-offs

- [Risk] Codex JSONL event shapes may change across CLI versions. -> Mitigation: parse defensively, keep unknown events as bounded sanitized progress summaries, and test with fixture JSONL streams.
- [Risk] Heartbeats and command output can make the timeline noisy. -> Mitigation: persist meaningful observations, throttle heartbeat events, and let the dashboard collapse repetitive liveness updates.
- [Risk] Raw provider output can contain credentials or sensitive local paths. -> Mitigation: sanitize before persistence, store bounded text, and keep raw event payloads out of durable events by default.
- [Risk] Switching final response extraction to JSONL can break existing provider behavior. -> Mitigation: keep focused tests for final result extraction, fallback behavior, timeout behavior, and non-zero exit behavior.
- [Risk] Adding subagent metadata before subagents exist can overfit. -> Mitigation: make metadata optional and use provider-agnostic names that are useful for current single-agent runs too.

## Migration Plan

1. Define domain/event contracts for structured agent observations and safe event data.
2. Extend the provider runtime to persist structured observations as durable events and publish them through the existing event bus.
3. Add Codex JSONL parsing behind the Codex provider boundary, preserving the current final response path.
4. Update dashboard timeline rendering for the new event types without requiring a full tree UI.
5. Later changes can add main-agent/subagent scheduling and use the same event layer by populating `agentRole`, `agentId`, `parentAgentId`, and `taskId`.

Rollback is straightforward if the provider keeps the existing last-message path: disable JSONL observability and continue to emit only existing lifecycle/final events.

## Future Scheduler Metadata

A later main-agent/subagent scheduler should populate observation metadata at the boundary where it starts or resumes an agent task:

- `agentRole`: stable role label such as `main`, `planner`, `worker`, `reviewer`, or `verifier`.
- `agentId`: durable id for the emitting agent within a goal run.
- `parentAgentId`: durable id for the delegating agent when the observation belongs to delegated work.
- `taskId`: durable id for the scheduler task or work item that the observation describes.

Provider adapters should continue to set `provider`, `model`, `source`, and `rawEventType` from their own execution context. The scheduler should merge its agent/task metadata into the provider observation before the runtime persists it. This change intentionally does not create scheduler queues, subagent processes, task assignment, or parent/child tree projection; it only keeps the durable event shape ready for those later changes.

## Follow-up Change Order

This change is the foundation for later user-facing agent visibility work. The intended sequence is:

1. Complete `add-agent-observability-event-layer` first so provider and runtime activity is represented as durable, sanitized timeline events.
2. Add a follow-up live status model that derives current state from observation events, such as last activity, current command, stalled or waiting state, and active provider context.
3. Add a multi-agent run tree after the live status model so main-agent/subagent relationships can show both parent-child structure and each agent or task's current state.

The multi-agent run tree MAY reuse the observability event metadata directly, but it SHOULD depend on the live status model for clear "what is happening now" dashboard behavior rather than deriving status ad hoc in the UI.

## Open Questions

- Which exact Codex JSONL event types should be promoted to first-class timeline event types versus shown as generic progress?
- Should heartbeat events be persisted durably, or should they update a transient "last seen" state while only meaningful progress is durable?
- Should command stdout/stderr summaries be stored as separate event data fields or only as sanitized messages?
- Should the first dashboard pass include grouping by `agentId`, or should grouping wait until subagent orchestration exists?
