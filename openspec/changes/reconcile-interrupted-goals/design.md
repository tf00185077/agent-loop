## Context

`recoverOrphanedSessions` (agent-session-manager.ts ~168) runs once at boot
(`app.ts:110`, before the Phase 2 worktree reclaim) and currently force-fails
every non-terminal session/goal. The durable substrate needed to do better
already exists: `listPendingDeliveries(goalId)` + `reconcilePendingDelivery`
(Phase 1), `detachDelegationRequest` and per-session delegation listing,
`interruptNonterminalIntegrations`, and the frozen managed-task contracts. The
recovery policy is governed by the `agent-runtime-control-plane` "Orphaned
process recovery state" requirement.

## Goals / Non-Goals

**Goals:**

- Reconcile a restart-interrupted goal into a clean, consistent, resumable state
  and mark it `interrupted` (non-terminal), with durable evidence.
- Reuse Phase 1/Phase 2 primitives; no schema change.

**Non-Goals:**

- Resuming/continuing the supervisor or rehydrating in-memory state (Phase 3b).
- Provider resume (Phase 4); delivery/worktree/completion mechanics unchanged.

## Decisions

**1. Rewrite `recoverOrphanedSessions` into a per-goal reconciler.** Group the
non-terminal sessions by goal. For each goal, in order: (a) reconcile every
`listPendingDeliveries(goalId)` row via `reconcilePendingDelivery({ supervisorCwd:
state.supervisorCwd, checkpointHead })`; (b) interrupt each in-flight worker
attempt and reset its task; (c) `interruptNonterminalIntegrations` (existing);
(d) mark stale sessions and set the goal to `interrupted`; (e) record one durable
recovery event summarizing the counts. The routine is idempotent — a re-run over
an already-`interrupted` goal finds no non-terminal session and does nothing, and
`reconcilePendingDelivery` is a no-op when already at the checkpoint.

**2. `interrupted` is a new, non-terminal `GoalStatus`.** Added to the domain
union (TEXT column, no migration). It is excluded from every "terminal goal" set
(Phase 2 worktree reclaim, completion checks) so the goal stays resumable. Audit
exhaustive `GoalStatus` switches (dashboard badges, status projections) and give
`interrupted` an explicit, non-terminal rendering.

**3. Interrupting an attempt must not penalize the retry budget, and must
discard its work.** Interrupt the in-flight delegation with
`detachDelegationRequest(..., "interrupted for restart recovery")`. Reset the
owning task to `registered` preserving `substantive_rejection_count` and the
frozen criteria, but do NOT count the interrupted (never-reviewed) attempt: the
task's `attempt_count` is adjusted so the interrupted attempt is not charged
against the two-rejection / three-attempt narrowing rule (a repo helper
`resetTaskForReDispatch(taskId)` performs the status + count adjustment
atomically). The interrupted attempt's worker worktree is reclaimed immediately
via the worktree service (the candidate was never committed under backend
authority, so the work is safely discarded) — Phase 2's terminal-goal reclaim
would otherwise skip it because the goal is now non-terminal.

**4. Enumerate in-flight worker attempts per goal via a durable query.** Add a
repository query returning worker delegation requests for a goal whose status is
`requested`/`accepted`/`running`, joined to their child session (for the worktree
path). Keeps the "what is in flight" decision in SQL over durable state.

## Risks / Trade-offs

- [A goal left `interrupted` with nothing resuming it (before Phase 3b ships)] →
  Accepted and honest: `interrupted` is a visible, durable, non-running state —
  strictly better than a zombie `running` or a lossy `failed`. Phase 3b resumes
  it. Until then it is a clean, resumable checkpoint an operator can inspect.
- [Adding a `GoalStatus` value breaks an exhaustive switch] → Mitigated by
  auditing switches and adding explicit `interrupted` handling; typecheck surfaces
  non-exhaustive unions in TS.
- [Reconcile runs before the Phase 2 worktree reclaim] → Intentional: the
  reconciler discards interrupted attempts' worktrees itself; Phase 2 then only
  handles genuinely terminal goals. No double-remove (removeWorktree is
  idempotent).

## Migration Plan

No data migration. Behavioral change to boot recovery only. Rollback restores the
force-fail `recoverOrphanedSessions`. Goals previously force-failed are
unaffected; only future restarts produce `interrupted` goals.

## Open Questions

- Should a goal whose ONLY in-flight work is a non-terminal integration (no
  worker attempt, no pending delivery) also become `interrupted`? Current
  decision: yes — any goal with a non-terminal session at boot is reconciled to
  `interrupted`; the integration is interrupted as today. Revisit if a
  goal-with-only-integration needs distinct handling in Phase 3b.
