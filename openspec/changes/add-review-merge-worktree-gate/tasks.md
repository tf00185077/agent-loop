## 1. Worktree Metadata and Isolation

- [ ] 1.1 Add worktree metadata fields to delegation/session read models and persistence.
- [ ] 1.2 Implement a worktree service that creates isolated child git worktrees and records their paths or labels.
- [ ] 1.3 Wire worker child spawning to use the isolated worktree as cwd.
- [ ] 1.4 Add tests for worktree creation, persisted metadata, and worker cwd isolation.

## 2. Review Merge Role

- [ ] 2.1 Add `review_merge` role validation on top of the managed delegation core request model.
- [ ] 2.2 Implement supervisor-initiated `review_merge` child spawning after worker results exist.
- [ ] 2.3 Ensure worker success does not automatically spawn review merge or apply changes.
- [ ] 2.4 Add tests for valid review merge requests, missing worker result rejection, and no automatic merge after worker success.

## 3. Workspace Checkpoint and Apply Gate

- [ ] 3.1 Add clean supervisor workspace verification before review merge starts.
- [ ] 3.2 Add pre-merge checkpoint recording for the supervisor workspace.
- [ ] 3.3 Implement apply outcome capture with diff summary evidence.
- [ ] 3.4 Add tests for clean workspace start, dirty workspace rejection, successful apply evidence, and conflict outcome.

## 4. Fixed Test and Revert Verification

- [ ] 4.1 Add configuration for the fixed review-merge test command.
- [ ] 4.2 Run the fixed test command after apply and persist command, exit code, and safe output summary.
- [ ] 4.3 Accept `merged` only when fixed test evidence passes verification.
- [ ] 4.4 Automatically verify revert state when tests fail after apply.
- [ ] 4.5 Record `test_failed_reverted`, `revert_failed`, `failed`, and `verification_failed` outcomes with safe summaries.
- [ ] 4.6 Add integration tests for merge success, conflict, test failure with revert, revert failure, and verification failure.

## 5. API and Dashboard Observability

- [ ] 5.1 Extend backend snapshots with worktree metadata and merge outcome read models.
- [ ] 5.2 Render worktree label/path, merge status, diff summary, fixed test result, and revert evidence in the dashboard.
- [ ] 5.3 Add UI/API tests for worktree metadata, successful merge display, rejected/conflict display, and reverted/verification failure display.

## 6. Verification and Documentation

- [ ] 6.1 Document review merge authority, fixed test command configuration, and worktree retention expectations.
- [ ] 6.2 Run `npm run typecheck`.
- [ ] 6.3 Run `npm test`.
- [ ] 6.4 Run `openspec validate add-review-merge-worktree-gate --strict`.
