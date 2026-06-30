## Why

The project needs real agent delegation instead of hidden subprocesses or UI-only intent: a supervisor must be able to spawn child work, receive the result automatically, and continue judging the next step. Codex is the first adapter used to converge the behavior, but the control plane should remain provider-agnostic so other commercial model adapters can be added later.

## What Changes

- Add managed delegation continuations where a supervisor session can request a backend-spawned child session through a structured, tool-shaped control event.
- Limit v1 to one active child at a time and maximum delegation depth of one so the behavior is easy to test.
- Add `worker` and `review_merge` delegation roles:
  - `worker` runs with read/write authority inside an isolated git worktree and cannot modify the supervisor workspace.
  - `review_merge` reads child output/worktree state, writes directly to the supervisor workspace, runs a fixed test command, and applies/reverts changes itself.
- Return child success, failure, timeout, cancellation, and merge outcomes to the supervisor as observations; these outcomes do not automatically fail the parent goal.
- Preserve child execution when the supervisor is cancelled or terminal; late child results are marked detached/ignored instead of force-cancelling work that may be mid-write.
- Let the supervisor decide when to spawn `review_merge`; the backend does not automatically merge worker output.
- Add backend merge verification with checkpointing, clean workspace checks, diff/test evidence, and explicit failure outcomes.
- Add dashboard-observable delegation state, including session tree, role, worktree, result status, merge outcome, and detached/ignored child results.
- Non-goals for this change: multi-child fan-out, nested delegation, distributed workers, full permission policy, budget accounting, and mandatory MCP transport.

## Capabilities

### New Capabilities
- `managed-delegation-continuations`: Supervisor-managed child sessions, continuation semantics, isolated worktrees, and review/merge gating.

### Modified Capabilities
- `agent-runtime-control-plane`: Add provider-agnostic delegation control events and lifecycle states for waiting on child sessions and continuing after child results.
- `dashboard-goal-lifecycle`: Surface delegation/session tree state and merge outcomes as first-class dashboard progress.

## Impact

- Affects domain/session models for parent-child run relationships, delegation roles, worktree metadata, and merge outcomes.
- Affects runtime control flow for spawning child sessions, continuing supervisors, handling detached child results, and validating structured control events.
- Affects git/workspace integration for isolated child worktrees and supervisor workspace merge checkpoints.
- Affects dashboard/API event payloads for visible delegation status and review/merge results.
