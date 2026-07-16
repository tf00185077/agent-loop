## Why

Backend delivery is write-behind, which is a dual-write hazard (Phase 1 of the
crash-durable roadmap). The manager runs every git side effect of a delivery
(create the candidate commit, cherry-pick it into the supervisor workspace, run
fixed validation, commit) and only *after* all of that persists the delivery
row. A crash between the supervisor commit landing and the row write leaves git
with a real commit but the DB with no delivery record at all. The completion
evaluator would then see undelivered changes and a future run would cherry-pick
the same change again — a double-commit / orphan-commit corruption. The fix is
to record delivery intent *before* the supervisor-mutating apply and to make a
pending delivery reconcilable against git ground truth.

## What Changes

- Split the delivery service so a candidate is *prepared* (worker-worktree
  commit → candidate SHA + clean supervisor checkpoint) separately from being
  *applied* (cherry-pick into supervisor + fixed validation + commit). The
  existing `deliverCandidate` already is the "apply" half; the normal path is
  refactored to `prepare` + `apply` and reuses it.
- The manager persists a durable delivery `pending` row carrying the
  idempotency key (candidate commit SHA + checkpoint HEAD) **before** the
  supervisor-mutating cherry-pick, then updates that same row to the terminal
  outcome after. This reuses the existing `managed_task_deliveries` `pending`
  status, `candidate_commit_sha`/`checkpoint_head` columns, and the
  `UNIQUE(worker_delegation_request_id)` row identity — no schema change.
- Add `reconcilePendingDelivery`: given a pending delivery's checkpoint HEAD, it
  consults git and resets the supervisor workspace to that recorded clean
  checkpoint (discarding any partial or unvalidated cherry-pick), so a later
  clean re-delivery is safe and can never double-commit or ship unvalidated
  code. The checkpoint is the idempotency anchor.
- The integration-recovery `deliverCandidate` call site is brought under the
  same write-ahead pending-row ordering.

Non-goals (explicitly deferred, do not touch here):

- **Wiring** `reconcilePendingDelivery` into startup recovery. This change adds
  the write-ahead ordering + the reconcile primitive with unit-level proof only.
  The boot-time reconciler that calls it and replaces `recoverOrphanedSessions`
  force-fail-all is Phase 3.
- Orphaned worktree cleanup (Phase 2) and provider session resume (Phase 4).
- Any change to what a *successful* delivery produces (same terminal row, same
  git result) or to the accepted-judge gating of candidate application.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `durable-managed-task-state`: add requirements that (1) a delivery persists its
  intent with the candidate + checkpoint idempotency key before mutating the
  supervisor workspace, and (2) a pending delivery is reconcilable to its
  recorded clean checkpoint against git ground truth without double-applying.

## Impact

- `src/runtime/agent-session/managed-delivery-service.ts` — split `deliver` into
  `prepareCandidate` + reuse `deliverCandidate` as apply; add
  `reconcilePendingDelivery`.
- `src/runtime/agent-session/agent-session-manager.ts` — delivery call sites
  (~1129 normal, ~1346 integration) orchestrate prepare → record pending →
  apply → record terminal.
- `src/persistence/managed-task-repository.ts` — `recordDelivery` supports
  insert-pending-then-update on the unique worker-delegation row; add a query
  for pending deliveries.
- No SQLite schema change (reuses existing `managed_task_deliveries` columns and
  statuses).
- Tests: new coverage for pending-before-cherry-pick ordering, reconcile reset
  behavior, and unchanged happy-path git result.
