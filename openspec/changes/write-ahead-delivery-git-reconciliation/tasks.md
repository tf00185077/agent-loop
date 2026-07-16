## 1. Split the delivery service (TDD)

- [ ] 1.1 Write failing tests (real temp git repos) for a new `prepareCandidate(input)` that does attestation + clean-supervisor check + worker-worktree candidate commit and returns `{ candidateCommitSha, checkpointHead, candidateFiles }`, plus its failure outcomes (dirty supervisor, attestation mismatch, no changes).
- [ ] 1.2 Implement `prepareCandidate` by extracting steps 1–3 of the current `deliver`, leaving the exact git commands unchanged.
- [ ] 1.3 Re-express `deliver` as `prepareCandidate` + the existing `deliverCandidate` (apply) and assert (test) the happy-path result and supervisor git state are byte-for-byte identical to the pre-refactor `deliver` (single candidate commit, same commit SHA reachability, same validation outcome).

## 2. Reconcile primitive (TDD)

- [ ] 2.1 Write failing tests for `reconcilePendingDelivery({ supervisorCwd, checkpointHead })`: when the supervisor has a cherry-picked commit on top of the checkpoint, it aborts/reset-hard/cleans back to the checkpoint and verifies HEAD == checkpoint and clean; when already at the checkpoint it is a no-op reporting "at checkpoint"; when the reset cannot be verified it reports failure without leaving a half-reset state.
- [ ] 2.2 Implement `reconcilePendingDelivery`, reusing the service's existing `restoreCheckpoint` helper; it must never re-apply or re-validate.

## 3. Persistence: pending-then-update + pending query (TDD)

- [ ] 3.1 Write failing tests for `recordDelivery` upsert semantics: a `pending` write followed by a terminal write for the same `worker_delegation_request_id` results in exactly one row ending in the terminal status with the candidate SHA + checkpoint preserved.
- [ ] 3.2 Write a failing test for `listPendingDeliveries(goalId)` returning only rows whose status is `pending` for that goal.
- [ ] 3.3 Implement the `recordDelivery` upsert path and `listPendingDeliveries` (no schema change; reuse existing columns and the unique constraint).

## 4. Manager write-ahead ordering (TDD)

- [ ] 4.1 Write a failing manager-level test: on the normal delivery path a `pending` delivery row with candidate SHA + checkpoint exists before the cherry-pick, and it becomes the terminal outcome after (use a fault injected between prepare and apply to assert the pending row is durable at that instant).
- [ ] 4.2 Rewire the normal delivery call site (`agent-session-manager.ts` ~1129): prepare → `recordDelivery(pending)` → apply → `recordDelivery(terminal)`; preserve conflict → conditional integration recovery and all existing terminal branches.
- [ ] 4.3 Bring the integration-recovery `deliverCandidate` call site (~1346) under the same write-ahead pending-row ordering.
- [ ] 4.4 Confirm (test) the conflict, test-failed-reverted, and verification-failed branches still produce their existing terminal delivery statuses.

## 5. Verify and commit

- [ ] 5.1 Run focused tests for the changed files; all green.
- [ ] 5.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [ ] 5.3 Live smoke per CLAUDE.md: start the API, drive a managed goal that produces a delivery, and confirm via the durable event/delivery timeline that a normal delivery still commits exactly once with no orphaned commit. Record findings in this change's `verification.md`.
- [ ] 5.4 Commit the task group with an imperative message naming the change (`write-ahead-delivery-git-reconciliation`).
