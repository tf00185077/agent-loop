## Context

Durable events give auto-agent an audit trail, but the MVP delegation loop also needs a small derived status so the dashboard can show whether the supervisor is running, waiting on a child, continuing, completed, failed, or blocked. The goal is a simple status summary, not a full live-operations dashboard.

## Goals / Non-Goals

**Goals:**

- Derive a stable minimal live status view from durable events in timeline order.
- Make status reconstructable after refresh, reconnect, or backend restart.
- Provide enough state for a dashboard summary: current state, safe summary, last activity, provider/model, and optional agent/task identifiers.
- Represent the MVP delegation states introduced by managed child sessions.

**Non-Goals:**

- Do not add a multi-agent tree UI in this change.
- Do not implement a main-agent/subagent scheduler.
- Do not add rich stalled/no-recent-activity policy in the MVP.
- Do not attach the dashboard directly to provider stdout/stderr.
- Do not persist raw provider payloads or derive status from unsanitized output.
- Do not require SSE-specific behavior to prove the status model.

## Decisions

1. Derive status from durable events, not in-memory process state.

   The status reducer will consume the same persisted events used by the timeline. This keeps refresh/reconnect behavior deterministic and avoids separate live-only semantics.

2. Treat live status as a minimal view model.

   The reducer should not replace event history. It creates a compact view with fields such as `state`, `lastActivityAt`, `summary`, `provider`, `model`, `agentId`, `agentRole`, `parentAgentId`, and `taskId`.

3. Prefer control-plane states over free-form parsing.

   Managed-session and delegation events should drive states such as waiting on child, continuing, cancelled, failed, and completed. Plain progress messages can update last activity and summary, but should not require brittle string parsing.

4. Keep future orchestration metadata optional.

   Agent and task metadata should be carried through the status model when present, but single-agent runs must work cleanly without parent or task identifiers.

## Risks / Trade-offs

- [Status can disagree with timeline if reducer rules are ambiguous] -> Keep reducer deterministic and test event sequences explicitly.
- [Minimal status may not explain every stall] -> Defer rich stalled diagnostics until the MVP loop is working.
- [Providers emit partial metadata] -> Tolerate missing optional fields and fall back to goal/run-level status.
- [Safe summaries can leak if derived from raw output] -> Only consume sanitized event messages/data.

## Migration Plan

1. Define the minimal live status view model and reducer tests.
2. Expose derived status through backend goal detail or a goal-scoped status endpoint.
3. Render compact status in the dashboard.
4. Keep multi-agent tree rendering and rich live telemetry for future changes.
