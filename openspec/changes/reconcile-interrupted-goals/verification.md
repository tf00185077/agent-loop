# Verification — reconcile-interrupted-goals (Phase 3a)

## Automated tests

- `src/runtime/agent-session/reconcile-interrupted-goals.test.ts` — 3/3 pass
  (real git repos + real SQLite + real delivery/worktree services):
  - **Full reconcile end-to-end**: a goal with a running worker attempt (real
    worktree) and a pending delivery whose candidate was cherry-picked onto the
    supervisor (git ahead of the checkpoint). After recovery: the supervisor
    workspace is **reset to the checkpoint**, the goal is `interrupted` (not
    `failed`), task-1 is `registered` with `attemptCount` decremented (interrupted
    attempt not charged), the in-flight attempt is interrupted, and a durable
    `recovery.reconciled` event records `deliveriesReset=1, attemptsInterrupted=1,
    tasksReset=1`.
  - An idle goal (live session, nothing in flight) is still moved to `interrupted`
    with a recovery event and no workspace change.
  - Recovery is idempotent: a second boot over an `interrupted` goal produces no
    duplicate recovery event and no further change.
- `src/persistence/runtime-repositories.test.ts` — 13 pass: new
  `listInFlightWorkerAttemptsForGoal` returns only requested/accepted/running
  worker delegations (with the child worktree), excluding terminal ones.
- `src/persistence/managed-task-repository.test.ts` — new `resetTaskForReDispatch`
  resets to `registered`, preserves criteria + rejection count, and decrements
  `attempt_count` so the interrupted attempt is not charged.
- Updated `agent-session-manager.test.ts` recovery test to assert the new
  behavior (session `stalled`, run `failed`, goal `interrupted`, a
  `recovery.reconciled` event) instead of the old force-fail-to-`failed`.
- `npm run typecheck` — clean. `npm test` — 487 pass, 0 fail, 14 skipped.

## Live smoke

The full-reconcile automated test above IS the live-substrate smoke: it drives a
real git repo (real `git worktree add`, real `cherry-pick`, real
`reconcilePendingDelivery` reset) and a real SQLite database, exactly the
substrate the boot path uses. Additionally, a real API boot
(`node --import tsx src/backend/server.ts`, `AUTO_AGENT_PROVIDER=mock`,
`PORT=3503`) with the rewritten `recoverOrphanedSessions` wired started cleanly
and ran a goal to `goal.completed`, confirming no boot/startup regression.

## Scope

3a leaves the goal cleanly `interrupted` and stops — it does NOT resume
execution (restart the supervisor / rehydrate in-memory state); that is Phase 3b.
`interrupted` is a new non-terminal `GoalStatus` (excluded from terminal-goal
sets, rendered amber in the dashboard). Delivery mechanics, worktree reclaim, and
the completion gate are unchanged.
