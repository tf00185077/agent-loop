## Context

`add-agent-observability-event-layer` creates durable, sanitized observation events for provider progress, command lifecycle, liveness, failures, and future agent/task metadata. That gives the system facts, but the dashboard still needs a compact derived view so users can tell whether work is active, quiet, waiting, stalled, or terminal without reading every event.

## Goals / Non-Goals

**Goals:**

- Derive a stable live status view from durable events in timeline order.
- Make status reconstructable after refresh, reconnect, or backend restart.
- Provide enough state for a dashboard summary: current state, safe summary, last activity, current command, current task, provider/model, and optional agent/task identifiers.
- Represent waiting and blocked causes when safe observation metadata is available.
- Keep the model useful for both current single-agent runs and future subagent runs.

**Non-Goals:**

- Do not add a multi-agent tree UI in this change.
- Do not implement a main-agent/subagent scheduler.
- Do not attach the dashboard directly to provider stdout/stderr.
- Do not persist raw provider payloads or derive status from unsanitized output.
- Do not require every provider to emit identical rich observations.

## Decisions

1. Derive status from durable events, not in-memory process state.

   The status reducer will consume the same persisted events used by the timeline. This keeps refresh/reconnect behavior deterministic and avoids separate live-only semantics.

2. Treat live status as a view model.

   The reducer should not replace event history. It creates a compact view with fields such as `state`, `lastActivityAt`, `currentCommand`, `currentTask`, `summary`, `provider`, `model`, `agentId`, `agentRole`, `parentAgentId`, and `taskId`.

3. Use configurable stale thresholds.

   A run can become `stalled` when no recent activity has been observed for a configured interval and no terminal event has arrived. This avoids filling the durable timeline with repetitive heartbeat events just to keep the UI fresh.

4. Prefer semantic states over message parsing.

   Command, heartbeat, waiting, failure, and timeout observations should drive status directly. Plain progress messages can update last activity and summary, but should not require brittle string parsing.

5. Keep multi-agent support optional.

   Agent and task metadata should be carried through the status model when present, but single-agent runs must work cleanly without parent or task identifiers.

6. Prefer runtime-control session events for control state.

   When `add-agent-runtime-control-plane` is present, lifecycle state, waiting-for-approval, cancellation, and adapter-loss status should come from managed session/runtime events and session snapshots. Observation events remain the source for current activity summaries such as command progress, task labels, provider/model metadata, and heartbeat-derived liveness. The reducer should not infer approval or cancellation state from free-form provider output when control-plane metadata is available.

## Risks / Trade-offs

- [Risk] Status can disagree with timeline if reducer rules are ambiguous. -> Mitigation: keep reducer deterministic and test event sequences explicitly.
- [Risk] Stalled detection can be noisy. -> Mitigation: make thresholds configurable and only mark stalled for active non-terminal runs.
- [Risk] Providers emit partial metadata. -> Mitigation: tolerate missing optional fields and fall back to goal/run-level status.
- [Risk] Safe summaries can leak if derived from raw output. -> Mitigation: only consume sanitized event messages/data.

## Migration Plan

1. Complete `add-agent-observability-event-layer`.
2. Define the live status view model and reducer tests.
3. Expose derived status through backend goal detail or a goal-scoped status endpoint.
4. Render compact status in the dashboard and update it from streamed events.
5. Keep multi-agent tree rendering for the later `add-multi-agent-run-tree` change.
