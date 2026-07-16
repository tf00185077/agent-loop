## Why

Worker worktrees are a disk side effect (`git worktree add`) recorded durably on
the child session, but nothing ever reclaims them. On restart
`recoverOrphanedSessions` marks sessions/goals failed yet leaves their worktrees
on disk, so orphans accumulate under `..\<repo>-worktrees\*` — CLAUDE.md even
documents a manual prune step. This is the reconcilable-disk class of the
crash-durable roadmap (Phase 2, hotspot #3): because the worktree path is durably
recorded, startup recovery can enumerate and clean the orphans deterministically.

## What Changes

- Add a startup worktree reconciliation that enumerates worktrees recorded on
  agent sessions whose owning goal is terminal (`failed`/`completed`/`blocked`/
  `cancelled`) and removes each from disk through the worktree service, recording
  a durable event per cleaned or already-absent worktree.
- The reconciliation is **idempotent** (removing an already-absent worktree is a
  no-op success), **safe** (it operates only on paths durably recorded on agent
  sessions — never arbitrary filesystem paths), and **never fails boot** (a
  removal error is recorded durably and startup continues).
- Wire it into backend startup (`app.ts`) to run after the existing
  `recoverOrphanedSessions` call, so goals just force-failed during recovery have
  their worktrees reclaimed in the same boot.
- Add a repository query that returns the durable worktree records for sessions
  whose goal is terminal (the enumeration source; no schema change).

Non-goals (explicitly deferred, do not touch here):

- The per-phase recovery reconciler that continues goals instead of force-failing
  (Phase 3). This change does not change `recoverOrphanedSessions`' force-fail
  behavior and does not resume anything.
- Cleaning worktrees for **non-terminal** goals — a later resume phase owns that
  policy, since a resumable in-flight worktree must not be reclaimed blindly.
- Delivery reconcile wiring (Phase 3) and provider session resume (Phase 4).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `review-merge-worktree-gate`: add a requirement that worker worktrees recorded
  for terminal goals are reclaimed from disk on startup, idempotently and
  safely, replacing the manual prune.

## Impact

- `src/backend/app.ts` — call the new worktree reconciliation after
  `recoverOrphanedSessions`.
- `src/runtime/agent-session/agent-session-manager.ts` (or a focused sibling) —
  the reconciliation routine, using the worktree service `removeWorktree`.
- `src/runtime/agent-session/worktree-service.ts` — `removeWorktree` becomes a
  required, relied-upon method.
- `src/persistence/runtime-repositories.ts` — a query returning worktree records
  for terminal-goal sessions (no schema change).
- Durable events: a new worktree-reclaimed event type; no schema change.
