## Why

Two background async boundaries in the runtime swallow unhandled failures, which
violates the project rule "degrade visibly, never silently." When an exception
escapes the orchestration path outside the normal durable-event flow, the goal is
left stuck in `running` with no durable trace — invisible until the next backend
restart force-fails it. This is the smallest, lowest-risk first step of the
larger crash-durability effort and it closes a real silent-failure hole today.

## What Changes

- The goal-start background run (`runtime.run(...)` launched from the start
  route) SHALL, on any otherwise-unhandled rejection, record a durable failure
  event for the goal and transition the goal to a durable terminal state,
  instead of only calling `console.error`.
- The child event-consumption loop (`consumeChildEvents`, currently launched as
  an unobserved `void` promise) SHALL, on any otherwise-unhandled rejection,
  record a durable failure event scoped to the affected delegation/session,
  instead of surfacing as an `unhandledRejection` with no durable trace.
- Both boundaries remain best-effort *outermost* safety nets: failures already
  handled through the normal durable-event path keep their existing behavior and
  are not double-recorded.

Non-goals (explicitly deferred to later separate changes, do not touch here):

- Replacing `recoverOrphanedSessions` force-fail-all with a per-phase
  crash-recovery reconciler.
- Write-ahead delivery intent + git reconciliation.
- Orphaned worktree cleanup.
- Provider session id persistence / supervisor session resume.
- Any new retry, resume, or continuation behavior. This change only makes the
  failure *visible and durable*; it does not attempt to recover from it.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `supervisor-goal-orchestration`: add a requirement that an unhandled failure
  in the goal's background supervisor run is recorded as a durable goal failure
  event with a durable goal status transition, not a console-only log.
- `managed-delegation-core`: add a requirement that an unhandled failure in the
  child event-consumption loop is recorded as a durable failure event for the
  affected delegation/session, not an unobserved promise rejection.

## Impact

- `src/backend/routes/goals.ts` — the start-route background `runtime.run(...)`
  rejection handler.
- `src/runtime/agent-session/delegation-coordinator.ts` — the `void
  consumeChildEvents(...)` launch site and/or a wrapper around it.
- Durable event stream: a new failure event may appear for goals/delegations
  that previously produced no durable record. No schema change expected (reuses
  the existing `events` table and `error` event type).
- Tests: new unit coverage that injects a throw at each boundary and asserts the
  durable event + status transition; existing behavior on the success path is
  unchanged.
