## ADDED Requirements

### Requirement: Worker worktree isolation
The system SHALL run worker children in isolated local git worktrees and persist safe worktree metadata.

#### Scenario: Worker receives isolated worktree
- **WHEN** the backend spawns a worker child for delegated implementation work
- **THEN** the child runs with its cwd set to a dedicated git worktree and the worktree path or label is recorded durably

### Requirement: Review merge role
The system SHALL support a supervisor-triggered `review_merge` child role that can inspect worker output and apply or reject changes in the supervisor workspace.

#### Scenario: Supervisor requests review merge
- **WHEN** a supervisor emits a valid delegation request for `review_merge` after a worker result exists
- **THEN** the backend spawns a review merge child with access to the worker result and supervisor workspace authority

#### Scenario: Review merge is not automatic
- **WHEN** a worker child completes successfully
- **THEN** the backend records the worker result without automatically applying changes or spawning review merge

### Requirement: Supervisor workspace checkpoint
The system SHALL require a clean supervisor workspace and checkpoint before review merge applies changes.

#### Scenario: Workspace is clean
- **WHEN** review merge starts and the supervisor workspace is clean
- **THEN** the backend records a pre-merge checkpoint before allowing apply behavior

#### Scenario: Workspace is dirty
- **WHEN** review merge starts and the supervisor workspace has uncommitted or untracked changes outside the accepted checkpoint policy
- **THEN** the backend rejects or fails review merge before applying worker changes

### Requirement: Merge outcome validation
The system SHALL validate review merge outcomes for `merged`, `rejected`, `conflict`, `test_failed_reverted`, `revert_failed`, `failed`, and `verification_failed`.

#### Scenario: Merge succeeds
- **WHEN** review merge applies changes and required verification passes
- **THEN** the backend records `merged` with diff summary and test evidence

#### Scenario: Merge is rejected
- **WHEN** review merge decides not to apply worker changes
- **THEN** the backend records `rejected` with a safe reason and leaves the supervisor workspace unchanged

#### Scenario: Conflict prevents apply
- **WHEN** review merge cannot apply changes because of conflicts
- **THEN** the backend records `conflict` and does not require revert evidence if no apply occurred

### Requirement: Fixed test gate
The system SHALL run the configured fixed test command after apply and require evidence before accepting `merged`.

#### Scenario: Tests pass after apply
- **WHEN** review merge applies changes and the fixed test command exits successfully
- **THEN** the backend accepts `merged` with the command, exit code, and safe output summary

#### Scenario: Tests fail after apply
- **WHEN** review merge applies changes and the fixed test command fails
- **THEN** the backend requires the supervisor workspace to be reverted and records `test_failed_reverted` only after revert verification passes

### Requirement: Revert verification
The system SHALL verify supervisor workspace state after failed test or failed apply outcomes that require revert.

#### Scenario: Revert succeeds
- **WHEN** review merge reverts after a failed test
- **THEN** the backend verifies the workspace matches the pre-merge checkpoint and records revert evidence

#### Scenario: Revert fails
- **WHEN** review merge cannot restore the pre-merge checkpoint state
- **THEN** the backend records `revert_failed` or `verification_failed` with a safe summary
