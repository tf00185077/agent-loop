## 1. Repository enumeration (TDD)

- [ ] 1.1 Write a failing test for `listWorktreesForTerminalGoals()`: it returns `{ sessionId, goalId, worktree }` only for sessions whose goal status is terminal (`failed`/`completed`/`blocked`/`cancelled`) and whose `worktree` is non-null; excludes non-terminal goals and null-worktree sessions.
- [ ] 1.2 Implement `listWorktreesForTerminalGoals()` on the agent session repository (JOIN agent_sessions → goals; no schema change).

## 2. Startup worktree reconciliation (TDD)

- [ ] 2.1 Write failing tests for `reconcileOrphanedWorktrees()`: it removes each recorded terminal-goal worktree via the worktree service and records a durable reclaim event; a non-terminal-goal worktree is left untouched; an already-absent worktree is a successful no-op; a `removeWorktree` that throws is caught, recorded durably, and does not propagate.
- [ ] 2.2 Implement `reconcileOrphanedWorktrees()` on the agent session manager using `listWorktreesForTerminalGoals()` + the worktree service `removeWorktree({ parentCwd: state.supervisorCwd, path })`, wrapping each removal so failures become durable `worktree.reclaim_failed` events and never throw.
- [ ] 2.3 Make `removeWorktree` a required method on the `WorktreeService` interface and update any injected doubles.

## 3. Boot wiring

- [ ] 3.1 In `src/backend/app.ts`, call `reconcileOrphanedWorktrees()` immediately after `recoverOrphanedSessions()`.
- [ ] 3.2 Remove the manual-prune instruction from CLAUDE.md now that cleanup is automatic.

## 4. Verify and commit

- [ ] 4.1 Run focused tests for the changed files; all green.
- [ ] 4.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [ ] 4.3 Live smoke per CLAUDE.md: create a real recorded worktree for a terminal goal, boot the backend, and confirm the worktree is removed from disk and a durable reclaim event is recorded. Record findings in this change's `verification.md`.
- [ ] 4.4 Commit the task group with an imperative message naming the change (`reconcile-orphaned-worktrees`).
