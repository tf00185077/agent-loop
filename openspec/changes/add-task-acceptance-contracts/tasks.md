# Tasks: add-task-acceptance-contracts

## 1. Contract Types + Control-Event Validation

- [ ] 1.1 Add domain types: `TaskAcceptanceCriterion {id, text}`, acceptance on task-list entries and delegation control events, `managed_task.result` control event (criterionEvidence, tests, claimedFiles), structured fields on `AgentRuntimeDelegationSummary` (criterionEvidence, tests, claimedFiles, attestedFiles).
- [ ] 1.2 Add tests + implementation in `validateManagedControlEvent`: task_list entries accept optional `acceptance` (validated shape, non-empty ids/text, unique ids); delegation requests accept optional `acceptance`; new `managed_task.result` kind validated.
- [ ] 1.3 Run focused validation tests and typecheck.

## 2. Persistence

- [ ] 2.1 Add tests + implementation: delegation requests persist `acceptance` (criteria snapshot JSON) and structured `resultSummary` fields via additive `ensureColumn` migration; repository read/write round-trips.
- [ ] 2.2 Update database schema test for new columns.

## 3. Task Registry + Backend Enforcement

- [ ] 3.1 Add session-manager tests: task registry built from task_list events (criteria frozen; restated criteria ignored with durable note); worker delegation for known task without criteria → `delegation.rejected` naming the missing contract; ad-hoc delegation (no taskId) accepted and marked uncontracted.
- [ ] 3.2 Implement the per-goal task registry and dispatch-time validators in the session manager (frozen-copy injection into coordinator dispatch).
- [ ] 3.3 Add tests: substantive rejection counting — verdicts citing frozen criterion IDs increment the count; uncited objections recorded as `deferred_finding` events without status change.
- [ ] 3.4 Implement verdict classification (parse cited criterion IDs from review/rejection outcomes) and deferred-finding recording.
- [ ] 3.5 Add tests: third identical-scope delegation after 2 substantive rejections → `delegation.rejected` with split instruction; narrower split tasks (fewer criteria, parent lineage) accepted; lineage durable.
- [ ] 3.6 Implement the narrowing rule and split-lineage tracking.

## 4. Structured Results + Worktree Attestation

- [ ] 4.1 Add coordinator tests: `managed_task.result` control block in child output is captured into the delegation result; absent block falls back to safeSummary-only.
- [ ] 4.2 Implement structured-result capture in the delegation coordinator/child event flow.
- [ ] 4.3 Add tests: at worker terminal, backend attests changed files from worktree git status (injectable attestor); claimed-vs-attested mismatch recorded durably; attested list authoritative.
- [ ] 4.4 Implement worktree attestation service and wire it at child terminal outcomes.

## 5. Prompt Contract + Continuation Task History

- [ ] 5.1 Add prompt tests: bootstrap documents per-task acceptance requirement, frozen-ID/cite-only rules, worker `managed_task.result` format; task-history section renders task statuses, criterion outcomes, rejection counts, and split lineage.
- [ ] 5.2 Implement prompt sections and the task-history renderer fed from the registry; wire into continuation/nudge prompt builds.
- [ ] 5.3 Include the acceptance contract and result-block format in worker delegation prompts (criteria appended to the child prompt at dispatch).

## 6. End-to-End + Verification

- [ ] 6.1 Add a mock-adapter end-to-end test: task list with criteria → worker result → cited rejection ×2 → third retry refused → supervisor splits → narrower task passes → completion; all state reconstructable from durable events.
- [ ] 6.2 Run typecheck and the full test suite; document any unrelated pre-existing failures.
- [ ] 6.3 Update README (acceptance contract section) and run `openspec validate add-task-acceptance-contracts --strict`.
- [ ] 6.4 Live Codex smoke: re-run a two-task goal and compare re-decomposition/ping-pong behavior against the archived run's evidence; capture findings in `verification.md`.
