## ADDED Requirements

### Requirement: Dashboard shows review merge outcomes
The dashboard SHALL show review/merge status and evidence for `review_merge` sessions.

#### Scenario: Merge succeeds
- **WHEN** a review merge outcome is `merged`
- **THEN** the dashboard shows the merge status, diff summary, and fixed test command result

#### Scenario: Merge is reverted or rejected
- **WHEN** a review merge outcome is `rejected`, `conflict`, `test_failed_reverted`, `revert_failed`, `failed`, or `verification_failed`
- **THEN** the dashboard shows the outcome and the failure or revert summary without marking the whole goal failed automatically

### Requirement: Dashboard shows worktree metadata
The dashboard SHALL show safe worker worktree metadata when available.

#### Scenario: Worker has worktree metadata
- **WHEN** a worker child session has a recorded worktree label or path
- **THEN** the dashboard shows the worktree metadata near the child session state without exposing credential-bearing paths
