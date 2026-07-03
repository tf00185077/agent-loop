## Why

After managed delegation can create children and continue supervisors, the system needs a safe way to inspect and apply child work without letting implementation children mutate the supervisor workspace directly. Review merge behavior is risky enough to land as a separate change with explicit workspace checkpoints, tests, and revert evidence.

## What Changes

- Add isolated git worktree creation for implementation children and persist worktree metadata.
- Add a `review_merge` delegation role that can be spawned by the supervisor after a worker result exists.
- Require clean supervisor workspace checks and a pre-merge checkpoint before review merge applies changes.
- Validate review merge outcomes: `merged`, `rejected`, `conflict`, `test_failed_reverted`, `revert_failed`, `failed`, and `verification_failed`.
- Run a configured fixed test command after apply and require evidence before accepting `merged`.
- Automatically verify revert state when tests fail after apply.
- Add dashboard/API read models for review merge diff/test/revert status and merge outcome evidence.
- Depend on `managed-delegation-core` for parent-child lifecycle, child result continuation, and detached result handling.

## Capabilities

### New Capabilities
- `review-merge-worktree-gate`: Isolated worker worktrees, supervisor-initiated review merge sessions, merge outcome verification, fixed-test gating, and revert verification.

### Modified Capabilities
- `dashboard-goal-lifecycle`: Surface review merge status, diff/test/revert evidence, and final merge outcomes in goal snapshots and timelines.

## Impact

- Affects git/workspace integration for local child worktrees, supervisor workspace checkpoints, and cleanup/retention metadata.
- Affects managed runtime orchestration for `review_merge` authority and merge outcome validation.
- Affects backend configuration for the fixed review-merge test command.
- Affects dashboard timeline rendering for merge evidence and failure/revert summaries.
- Increases workspace side-effect risk, so implementation must be gated behind the completed managed delegation core.
