## Context

Worker worktrees are created in `delegation-coordinator.ts` (`createWorkerCwd` →
`worktreeService.createChildWorktree({ parentCwd: supervisorCwd, childSessionId })`)
and their `{ path, label }` is persisted on the child session via
`updateSessionWorktree`. The git worktree service already implements
`removeWorktree({ parentCwd, path })` (`git worktree remove --force` +
`git worktree prune`). `recoverOrphanedSessions` runs once at boot
(`app.ts:110`) and force-fails non-terminal sessions/goals but never touches
worktrees. The session repository can enumerate sessions but has no
"worktrees for terminal goals" query yet.

## Goals / Non-Goals

**Goals:**

- A deterministic, idempotent, safe startup pass that reclaims worktrees for
  terminal goals and records durable evidence.
- No schema change; reuse the recorded `agent_sessions.worktree` and the existing
  `removeWorktree`.

**Non-Goals:**

- Changing `recoverOrphanedSessions` force-fail behavior (Phase 3).
- Reclaiming non-terminal-goal worktrees (a resume phase owns that).
- Delivery reconcile wiring (Phase 3), provider resume (Phase 4).

## Decisions

**1. Enumerate from durable state via a new repository query.** Add
`listWorktreesForTerminalGoals()` to the session repository returning
`{ sessionId, goalId, worktree }` for sessions whose `goal.status` is terminal
and `worktree` is non-null (a JOIN on goals). This keeps the "which worktrees are
orphaned" decision in SQL over durable state, and guarantees the reconciler only
ever sees paths the backend itself recorded — never an arbitrary path.
Alternative rejected: scanning the `..\<repo>-worktrees\` directory — it would
act on paths not owned by the DB and cannot distinguish terminal from live.

**2. Reconcile after `recoverOrphanedSessions`, as its own routine.** Add
`reconcileOrphanedWorktrees()` on the agent session manager and call it in
`app.ts` immediately after `recoverOrphanedSessions()`. Ordering matters: recovery
force-fails in-flight goals first, so their now-terminal worktrees are included in
the same boot. Keeping it a separate routine avoids colliding with the Phase 3
rewrite of `recoverOrphanedSessions`.

**3. Idempotent, safe, never-throwing.** For each recorded worktree: call
`removeWorktree({ parentCwd, path })` (git `remove --force` + `prune` already
tolerate an already-absent worktree), wrapped so any error is caught, recorded as
a durable event, and does not propagate. `parentCwd` is the configured supervisor
cwd (`state.supervisorCwd`, default `process.cwd()`) — the main repo that owns the
worktrees. Each processed worktree records a durable `worktree.reclaimed` (or
`worktree.reclaim_failed`) event carrying the session id, goal id, and sanitized
label — never the raw absolute path beyond the existing safe metadata.

**4. `removeWorktree` becomes required on the service interface.** It is
currently optional; the reconciler depends on it, and the real git service
already implements it. Any injected test double must provide it.

## Risks / Trade-offs

- [Removing a worktree that a concurrent process is using] → At boot no managed
  session is running yet, and only terminal-goal worktrees are eligible, so
  nothing live is touched. Non-terminal goals are explicitly excluded.
- [`git worktree remove` fails because the path was manually deleted] → `remove
  --force` + `prune` tolerate this; the reconciler treats it as a no-op success.
- [A removal genuinely fails (locked file, permissions)] → Recorded durably as
  `worktree.reclaim_failed`; startup continues. The orphan remains but is visible.

## Migration Plan

No data migration. Purely additive boot behavior. Rollback is removing the
`app.ts` call. The manual-prune note in CLAUDE.md can be dropped once shipped.

## Open Questions

- Should reclaim also cover integration worktrees (`createIntegrationWorktree`)?
  Deferred: those are shorter-lived and tied to integration attempts; this change
  scopes to worker worktrees recorded on sessions. Revisit if integration
  worktrees are observed to leak.
