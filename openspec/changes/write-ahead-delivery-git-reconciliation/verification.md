# Verification — write-ahead-delivery-git-reconciliation

## Automated tests (real git + real SQLite — the actual delivery substrate)

- `src/runtime/agent-session/managed-delivery-service.test.ts` — 11/11 pass.
  - The 7 pre-existing `deliver` tests still pass, proving the `deliver =
    prepareCandidate + deliverCandidate` refactor is behavior-preserving
    (committed, attestation-fail, dirty-supervisor, test-failed-reverted,
    conflict-restored, revert_failed).
  - New: `prepareCandidate` creates a candidate + checkpoint **without mutating
    the supervisor** (asserts supervisor HEAD/clean unchanged); fails closed on
    attestation mismatch.
  - New: `reconcilePendingDelivery` resets a delivered commit back to the
    recorded checkpoint (HEAD == checkpoint, clean) and is a no-op when already
    at the checkpoint.
- `src/persistence/managed-task-repository.test.ts` — 9/9 pass. New: `recordDelivery`
  upserts a `pending` intent then its terminal outcome into exactly one row with
  the candidate SHA preserved; `listPendingDeliveries(goalId)` returns only
  pending rows.
- `src/runtime/agent-session/agent-session-manager.test.ts` — 41/41 pass. The
  committed-delivery test now asserts `pendingRowsAtApply === 1`, proving a
  durable pending delivery row exists **at the instant the supervisor-mutating
  apply runs** (write-ahead ordering). The conflict → conditional-integration
  path still delivers the resolved candidate and commits.
- `npm run typecheck` — clean.
- `npm test` — 477 pass, 0 fail, 14 skipped (pre-existing skips).

## Live smoke (boot regression)

Booted the real API (`node --import tsx src/backend/server.ts`,
`AUTO_AGENT_PROVIDER=mock`, `PORT=3501`, scratch DB). A goal created + started and
ran its durable timeline through to `goal.completed` (14 events), confirming the
delivery-service refactor and manager rewiring do not regress the API path.

## Note on the delivery live surface

The backend delivery path only runs under a managed supervisor session (real
Codex/Claude CLI), which is non-deterministic and requires a logged-in CLI. The
write-ahead ordering and reconcile primitive are instead exercised end-to-end
against **real git worktrees and real SQLite** in the service, repository, and
manager tests above — the same substrate the live path uses. Reconcile is
implemented and unit-proven but is not yet called at boot; wiring it into startup
recovery (and replacing `recoverOrphanedSessions` force-fail-all) is Phase 3.
