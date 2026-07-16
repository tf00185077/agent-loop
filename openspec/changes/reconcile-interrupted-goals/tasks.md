## 1. Domain: interrupted goal status

- [ ] 1.1 Add `interrupted` to the `GoalStatus` union in `src/domain/status.types.ts`.
- [ ] 1.2 Audit exhaustive `GoalStatus` handling (dashboard status rendering, any status projections / terminal-goal sets) and give `interrupted` explicit, non-terminal treatment; typecheck must stay clean.

## 2. Persistence: enumeration + task reset (TDD)

- [ ] 2.1 Write a failing test for a query listing in-flight worker attempts for a goal (delegation status `requested`/`accepted`/`running`, role `worker`, with the child session worktree path when present).
- [ ] 2.2 Implement that query on the agent session repository.
- [ ] 2.3 Write a failing test for `resetTaskForReDispatch(taskId)`: sets task status to `registered`, preserves `substantive_rejection_count` and frozen criteria, and adjusts `attempt_count` so the interrupted attempt is not charged.
- [ ] 2.4 Implement `resetTaskForReDispatch` on the managed task repository.

## 3. Startup reconciler (TDD)

- [ ] 3.1 Write failing tests for the rewritten recovery: given a goal with a pending delivery ahead of its checkpoint and a running worker attempt with a delegated task, assert after recovery that the supervisor workspace is reset to the checkpoint, the pending delivery + attempt are durably interrupted, the task is `registered` (counts preserved, not charged), the interrupted attempt's worktree is reclaimed, the goal is `interrupted` (not `failed`), and a durable recovery event is recorded.
- [ ] 3.2 Write a failing test: a goal with a non-terminal session but nothing in flight is still moved to `interrupted` with a recovery event and no workspace change.
- [ ] 3.3 Write a failing test: the reconciler is idempotent (a second run over an `interrupted` goal is a no-op).
- [ ] 3.4 Rewrite `recoverOrphanedSessions` into the per-goal reconciler: reconcile pending deliveries (`listPendingDeliveries` + `reconcilePendingDelivery`), interrupt in-flight worker attempts (`detachDelegationRequest` + `resetTaskForReDispatch` + worktree reclaim), keep `interruptNonterminalIntegrations`, mark sessions stale, set goal `interrupted`, and emit the durable recovery event. Keep it returning the recovered sessions for the existing caller.

## 4. Verify and commit

- [ ] 4.1 Run focused tests for the changed files; all green.
- [ ] 4.2 Run `npm run typecheck` and the full `npm test` suite; all green (update any test that asserted the old force-fail-to-`failed` recovery behavior).
- [ ] 4.3 Live smoke per CLAUDE.md: seed a real goal with an in-flight worker attempt + a pending delivery, run recovery, and confirm via the durable event/goal state that the goal is `interrupted`, the workspace is at the checkpoint, and the task is reset. Record findings in this change's `verification.md`.
- [ ] 4.4 Commit the task group with an imperative message naming the change (`reconcile-interrupted-goals`).
