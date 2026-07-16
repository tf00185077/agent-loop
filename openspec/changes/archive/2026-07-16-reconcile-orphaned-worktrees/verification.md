# Verification — reconcile-orphaned-worktrees

## Automated tests

- `src/persistence/runtime-repositories.test.ts` — 12/12 pass. New:
  `listWorktreesForTerminalGoals()` returns worktrees only for terminal-goal
  sessions with a non-null worktree; excludes non-terminal goals and null-worktree
  sessions.
- `src/runtime/agent-session/reconcile-orphaned-worktrees.test.ts` — 4/4 pass:
  a terminal-goal worktree is removed via the service and records a durable
  `worktree.reclaimed` event; a non-terminal-goal worktree is left untouched; a
  `removeWorktree` that rejects is caught, recorded as `worktree.reclaim_failed`,
  and does not propagate; an already-absent worktree is a durable no-op under the
  real git worktree service.
- `npm run typecheck` — clean.
- `npm test` — 482 pass, 0 fail, 14 skipped (pre-existing skips).

## Live smoke (real git worktree removed from disk)

Ran an end-to-end script: `git init` a repo, `git worktree add` a real child
worktree (confirmed present on disk), persisted a `failed` goal + session pointing
at that worktree in a real SQLite file, then invoked the real
`createAgentSessionManager(...).reconcileOrphanedWorktrees()` with the real
`createGitWorktreeService()`. Result:

- worktree directory on disk after reclaim: **removed**
- `git worktree list` still lists it: **no**
- durable `worktree.reclaimed` events: **1**
- overall: **SMOKE PASS**

## Wiring

`src/backend/app.ts` calls `reconcileOrphanedWorktrees()` (best-effort,
non-blocking) immediately after `recoverOrphanedSessions()`, so goals just
force-failed during recovery have their worktrees reclaimed in the same boot. The
manual-prune note in CLAUDE.md was replaced with a note that cleanup is automatic.
Non-terminal-goal worktrees are intentionally left untouched (a resume phase owns
that policy); `recoverOrphanedSessions` force-fail behavior is unchanged (Phase 3).
