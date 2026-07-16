## Context

`managed-delivery-service.ts` `deliver(input)` runs, in order: (1) attest the
worker worktree matches its attested files, (2) verify the supervisor workspace
is clean and record `checkpointHead = rev-parse HEAD`, (3) `git add` + commit in
the worker worktree → `candidateCommitSha`, (4) cherry-pick that candidate into
the supervisor workspace (the first product-mutating step), (5) run the fixed
validation, (6) commit or reset to the checkpoint. The manager
(`agent-session-manager.ts` ~1129) calls `deliver(...)` and only afterwards calls
`tasks.recordDelivery({...delivered})` — a single write behind all the git work.

The candidate SHA does not exist until step 3, and the product mutation is step
4, so a write-ahead intent must be persisted between step 3 and step 4. Git
worktrees share one object store, so a commit created in the worker worktree is
reachable by SHA from the supervisor worktree; the existing `deliverCandidate`
already relies on this to cherry-pick an integrator candidate.

## Goals / Non-Goals

**Goals:**

- Persist a `pending` delivery row (candidate SHA + checkpoint HEAD) before the
  supervisor-mutating cherry-pick; update it to terminal after.
- Provide `reconcilePendingDelivery` that restores the supervisor workspace to a
  pending delivery's recorded checkpoint, making re-delivery safe.
- Zero behavior change on the happy path; no SQLite schema change.

**Non-Goals:**

- Calling reconcile at boot / replacing `recoverOrphanedSessions` (Phase 3).
- Worktree cleanup (Phase 2), provider resume (Phase 4).
- Detecting "already validated & committed" to skip re-delivery (see Decisions).

## Decisions

**1. Split `deliver` into `prepareCandidate` + `applyCandidate`; reuse the
existing `deliverCandidate` as the apply half.** `prepareCandidate` performs
steps 1–3 and returns `{ candidateCommitSha, checkpointHead, candidateFiles }`.
`applyCandidate` performs steps 4–6 given a candidate SHA + checkpoint — which is
exactly what `deliverCandidate` already does. The manager orchestrates: prepare →
`recordDelivery(pending, key)` → apply → `recordDelivery(terminal)`. Rationale:
keeps the service pure git mechanics with no DB dependency (the backend owns
persistence ordering, per the architecture rules), makes the write-ahead point
explicit and testable in the manager, and unifies the normal and
integration-recovery paths on one apply function. Alternative rejected: inject a
"record pending" callback into `deliver` — it inverts control and makes the pure
git service aware of a persistence phase.

**2. Reconcile by resetting to the checkpoint, not by detecting committed
state.** A pending delivery means the terminal `recordDelivery` never ran, so we
cannot trust that fixed validation passed — the crash may have landed after the
cherry-pick but before validation. Detecting "candidate already at HEAD" (e.g.
via patch-id) could therefore mark an unvalidated commit as delivered.
`reconcilePendingDelivery` instead treats the recorded `checkpointHead` as the
idempotency anchor: it aborts any in-progress cherry-pick, `reset --hard` to the
checkpoint, cleans untracked files, and verifies HEAD == checkpoint and clean.
The pending row is left as-is; Phase 3 re-delivers from the clean checkpoint and
the re-delivery's terminal `recordDelivery` upserts the same unique row. This
guarantees exactly-one-commit and never ships unvalidated code. Reuses the
service's existing `restoreCheckpoint` helper.

**3. `recordDelivery` becomes insert-pending-then-update on the unique row.**
`managed_task_deliveries` already has `UNIQUE(worker_delegation_request_id)`, a
`pending` status, and `candidate_commit_sha` / `checkpoint_head` columns, so the
pending write and the terminal write target the same row (upsert). No schema
change. Add a `listPendingDeliveries(goalId)` read for Phase 3 to consume later.

## Risks / Trade-offs

- [Crash after a validated commit but before the terminal row write → reconcile
  resets a good commit and re-delivers, re-running fixed validation] →
  Accepted. Correctness and never-double-commit outweigh saving one revalidation;
  this only happens on an actual crash, never on the happy path.
- [`prepare`/`apply` refactor changes internal structure of a
  correctness-critical service] → Mitigated by keeping the exact git command
  sequence, reusing `deliverCandidate`/`restoreCheckpoint` unchanged, and
  asserting the happy-path git result is byte-for-byte the same in tests.
- [A pending row now exists transiently on the happy path] → It is updated to
  terminal within the same synchronous delivery; the completion evaluator only
  treats `committed` as delivered, so a transient pending never affects a
  non-crashed run.

## Migration Plan

No data migration. Existing delivery rows are unaffected. Rollback is reverting
the service split and the manager ordering. Reconcile is new code that nothing
calls yet (Phase 3 wires it), so it cannot regress current behavior.

## Open Questions

- Should `reconcilePendingDelivery` also transition the pending row to an
  explicit "reset, awaiting re-delivery" state? Deferred: the current status enum
  has no such value and adding one is a schema change; leaving the row `pending`
  and letting the upsert re-delivery finalize it keeps Phase 1 schema-free.
  Revisit in Phase 3 if the boot reconciler needs an explicit marker.
