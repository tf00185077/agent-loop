# Tasks: add-goal-scale-decomposition

## 1. Domain Types + Control-Event Validation

- [x] 1.1 Add domain types: `managed_change.plan` control event (`changes: [{id, title, rationale, dependsOn?}]`), change record/status types, optional `changeId` on task-list entries and delegation control events/requests.
- [x] 1.2 Add tests + implementation in `validateManagedControlEvent`: plan shape validation (unique ids, non-empty title/rationale, 2–8 changes, dependsOn references exist and are acyclic); `changeId` accepted on task lists and worker delegations.
- [x] 1.3 Persist `change_id` on delegation requests (additive `ensureColumn` + repository round-trip + schema test).

## 2. OpenSpec Workspace Service

- [x] 2.1 Add tests for `openspec-workspace-service` with injected runners: CLI detection via the reusable `cli-command-detection` config; scaffold materialization from internal templates; `validate --strict` gate; archive; degraded mode (no CLI) covering all four operations with durable downgrade reporting.
- [x] 2.2 Implement the service (spawnSync in the goal workspace, git commit of scaffolding with a prefixed message, degradation paths).
- [x] 2.3 Add internal structural checks used in both modes: every requirement has a WHEN/THEN scenario; every task in tasks.md carries acceptance criteria.

## 3. Change Registry + Sequencing Enforcement

- [x] 3.1 Add session-manager tests: valid plan accepted (durable plan event, changes registered, first change activated, spec task per change registered with frozen S1–S3 criteria); budget violations rejected; second plan rejected.
- [x] 3.2 Implement the per-goal change registry (`planned → specifying → executing → merging → archived | blocked`) and plan acceptance flow (scaffold + commit via the workspace service).
- [x] 3.3 Add tests: task lists/delegations inherit the active `changeId`; explicit mismatches rejected naming the active change; delegation rows carry `changeId`.
- [x] 3.4 Implement active-change tagging and mismatch rejection in the delegation gate.

## 4. Spec-Writer Delegations

- [x] 4.1 Add tests: spec-writer prompt appendix contains the change context, target paths, artifact templates, and S1–S3 criteria — and does not contain CLI workflow instructions.
- [x] 4.2 Implement the spec-writer appendix and wire it into dispatch for `spec:<changeId>` tasks.
- [x] 4.3 Add tests: spec-writer result triggers worktree validation (S1 via CLI or degraded checks); failure records a substantive rejection citing the failing criteria; success requires review-merge before the change leaves `specifying`.
- [x] 4.4 Implement the worktree validation hook at spec-writer terminal outcomes and the `specifying → executing` transition on merged, validated artifacts.

## 5. Change Completion + Archive Gating

- [x] 5.1 Add tests: change cannot archive while tasks are undone or attested worker changes are unmerged (durable missing-merge reason); archive on satisfied conditions emits `change.archived` and activates the next change; completion control block rejected while changes remain, accepted after the last archive.
- [x] 5.2 Implement completion conditions, archive execution (CLI/degraded), next-change activation, and the completion-signal gate.

## 6. Prompts + Continuation Change History

- [x] 6.1 Add prompt tests: bootstrap documents scale assessment and the plan format with an example; change history section renders plan status and the active change; plan-less goals render unchanged.
- [x] 6.2 Implement prompt contract sections and the change-history renderer wired into continuations/nudges.

## 7. End-to-End + Verification

- [x] 7.1 Add a mock-adapter e2e test: plan (2 changes) → spec-writer contracted → validate gate → tasks under change 1 → merged evidence → archive → change 2 → completion accepted only after both archives; all reconstructable from durable events.
- [x] 7.2 Run typecheck and the full test suite; document any unrelated pre-existing failures.
- [x] 7.3 Update README (goal-scale decomposition section) and run `openspec validate add-goal-scale-decomposition --strict`.
- [x] 7.4 Live Codex smoke with a deliberately larger goal; capture change-plan behavior and findings in `verification.md`.
