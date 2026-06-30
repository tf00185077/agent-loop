## ADDED Requirements

### Requirement: Dashboard shows managed delegation tree
The dashboard SHALL show parent-child relationships for managed sessions inside a goal run.

#### Scenario: Child session is active
- **WHEN** a supervisor has an active child session
- **THEN** the dashboard shows the child role, status, worktree path or label, and parent supervisor relationship

#### Scenario: Child session completes
- **WHEN** a child completes with success, failure, timeout, cancellation, detached, or ignored status
- **THEN** the dashboard shows the final child outcome in the goal timeline

### Requirement: Dashboard shows review merge outcomes
The dashboard SHALL show review/merge status and evidence for `review_merge` sessions.

#### Scenario: Merge succeeds
- **WHEN** a review merge outcome is `merged`
- **THEN** the dashboard shows the merge status, diff summary, and fixed test command result

#### Scenario: Merge is reverted or rejected
- **WHEN** a review merge outcome is `rejected`, `conflict`, `test_failed_reverted`, `revert_failed`, `failed`, or `verification_failed`
- **THEN** the dashboard shows the outcome and the failure or revert summary without marking the whole goal failed automatically
