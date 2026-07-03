## Why

The project needs a narrow, durable delegation core before adding workspace-changing review and merge behavior. A supervisor session should be able to request one backend-managed child session, observe the result, and continue without relying on parent-child metadata alone as the execution state.

## What Changes

- Add a provider-neutral structured delegation control event that a managed supervisor session can emit.
- Add a durable delegation request/claim model for parent-child session relationships, one-active-child enforcement, max-depth enforcement, child outcomes, and detached/ignored result state.
- Add lifecycle semantics for supervisor sessions waiting on child results and continuing after child completion.
- Spawn backend-managed `worker` child sessions through the managed runtime path, with child results returned to the supervisor as observations.
- Preserve child execution when the supervisor becomes terminal; late child results are stored as detached/ignored instead of resuming the supervisor.
- Add dashboard/API read models for the delegation tree and basic child status/outcome visibility.
- Keep review/merge, worktree creation, apply/revert, and fixed-test verification out of this change.

## Capabilities

### New Capabilities
- `managed-delegation-core`: Provider-neutral delegation requests, durable parent-child session state, child result handling, supervisor continuation, and detached result handling.

### Modified Capabilities
- `agent-runtime-control-plane`: Add delegation control-event validation, waiting-child lifecycle state, child result continuation events, and child-session scheduling capability semantics.
- `dashboard-goal-lifecycle`: Surface basic managed delegation tree state and child outcomes in goal snapshots and timelines.

## Impact

- Affects domain/session models for delegation roles, parent session ids, child session ids, child statuses, and detached/ignored result state.
- Affects SQLite persistence for durable delegation requests/claims and status transitions.
- Affects managed runtime control flow for validating delegation requests, spawning child sessions, recording outcomes, and continuing supervisors.
- Affects backend goal/session snapshot APIs and dashboard rendering for child session state.
- Establishes a dependency for a later review-merge/worktree gate change.
