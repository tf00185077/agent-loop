## Context

Two runtime async boundaries currently drop unhandled failures:

- `src/backend/routes/goals.ts` starts the background run with
  `runtime.run(goal.id, opts).catch((err) => console.error(...))`. The goal is
  set to `running` synchronously before this; a rejection here leaves the goal
  `running` with only a console line.
- `src/runtime/agent-session/delegation-coordinator.ts` launches
  `void consumeChildEvents(...)`. A rejection inside that loop (which also drives
  review + delivery via `onChildOutcome`) becomes an `unhandledRejection` with no
  durable trace.

The backend is the sole owner of side effects and already records durable events
for normal transitions. This change adds only an *outermost* durable safety net
around these two promises; it does not add recovery, retry, or resume.

## Goals / Non-Goals

**Goals:**

- Any otherwise-unhandled rejection at these two boundaries produces a durable
  failure event and a durable status transition.
- The safety net is idempotent: it never double-records a failure the normal
  path already persisted, and it never overwrites an already-terminal status.

**Non-Goals:**

- No crash-recovery reconciler, no change to `recoverOrphanedSessions`.
- No write-ahead delivery, worktree cleanup, or provider-session persistence.
- No retry/resume/continuation. Visibility only, not recovery.

## Decisions

**1. A single shared safety-net helper, called from both `.catch` handlers.**
Add one small function (e.g. `recordUnhandledRuntimeFailure`) that takes the
goal/run/session/delegation identifiers and an error, and performs the durable
write. Both boundaries call it. Rationale: one audited place for the
double-record guard, rather than duplicating logic. Alternative considered:
a global `process.on('unhandledRejection')` handler — rejected because it lacks
the goal/delegation context needed to scope the durable event and would fire for
unrelated rejections.

**2. Guard against double-recording by re-reading durable state at catch time.**
- Goal boundary: on catch, re-read the goal. If it is already in a terminal
  status (`completed`/`failed`/`blocked`), do nothing. Otherwise emit a durable
  `error` event for the goal and transition it to `failed`.
- Delegation boundary: on catch, emit a durable `error` event scoped to the
  delegation request id and child session id, and mark the child session
  `failed` only if it is not already terminal. The delegation request's own
  terminal transition is owned by `recordChildEvent` on the normal path; the
  safety net does not fabricate a delegation result summary.
Rationale: the normal path sets terminal state before the promise settles in the
success case, so a terminal re-read reliably means "already handled."

**3. Reuse the existing `events` table and `error` event type.** No schema
change. The event `data` carries the affected ids and a sanitized error message
(existing sanitizer), consistent with credential-safety rules.

**4. Keep the boundaries best-effort and non-throwing.** The safety-net helper
must itself never throw (wrap its own writes defensively) so it cannot create a
second unhandled rejection.

## Risks / Trade-offs

- [Double-recording a failure that the normal path also records] → Mitigated by
  the terminal-status re-read guard before writing; verified by a test where the
  normal path already set terminal state.
- [Racing status writes between the normal path and the safety net] → The runtime
  is single-process and SQLite writes are synchronous; the catch handler runs
  only after the awaited run/loop settles, so the normal path's terminal write
  has already committed before the guard reads it.
- [Scope creep toward recovery] → Explicit non-goals; specs assert visibility
  only. The goal ends `failed`, not resumed.

## Migration Plan

Pure additive behavior; no data migration. Rollback is reverting the two catch
handlers to their prior form. Existing success-path behavior is unchanged.

## Open Questions

- Should the delegation-boundary safety net also emit a goal-level `error` event,
  or only a delegation-scoped one? Current decision: delegation-scoped only, to
  keep the failure attributed to the child; the supervisor lifecycle is handled
  by its own boundary. Revisit if a live smoke shows the goal-level view needs it.
