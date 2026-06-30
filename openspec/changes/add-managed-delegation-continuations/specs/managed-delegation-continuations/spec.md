## ADDED Requirements

### Requirement: Supervisor-triggered managed child sessions
The system SHALL allow a supervisor session to request a backend-spawned child session through a structured, provider-agnostic delegation control event.

#### Scenario: Worker child is spawned
- **WHEN** a running supervisor emits a valid delegation control event for role `worker`
- **THEN** the backend creates one managed child session linked to the supervisor and persists a delegation-started event

#### Scenario: Active child already exists
- **WHEN** a supervisor with an active child emits another delegation control event
- **THEN** the backend rejects the request and records a delegation-rejected event explaining the one-active-child limit

#### Scenario: Child attempts nested delegation
- **WHEN** a child session emits a delegation control event
- **THEN** the backend rejects the request and records that maximum delegation depth has been reached

### Requirement: Delegation roles and workspace authority
The system SHALL enforce role-specific workspace authority for managed child sessions.

#### Scenario: Worker receives isolated worktree
- **WHEN** the backend spawns a `worker` child
- **THEN** the child runs in a dedicated git worktree and cannot write to the supervisor workspace through managed runtime APIs

#### Scenario: Review merge receives supervisor workspace authority
- **WHEN** the backend spawns a `review_merge` child
- **THEN** the child can read worker outputs and apply or revert changes in the supervisor workspace

### Requirement: Child outcomes continue the supervisor
The system SHALL return child outcomes to the supervisor as observations and continue the supervisor's decision loop.

#### Scenario: Child succeeds
- **WHEN** a child session completes successfully
- **THEN** the backend records the child result and resumes or starts a supervisor continuation with the result summary

#### Scenario: Child fails
- **WHEN** a child session fails, times out, or is cancelled
- **THEN** the backend records a failure summary and resumes or starts a supervisor continuation without automatically failing the parent goal

### Requirement: Detached child outcomes
The system SHALL preserve active child execution when the supervisor becomes terminal and mark late results as detached or ignored.

#### Scenario: Supervisor is cancelled while child runs
- **WHEN** the supervisor is cancelled while a child session remains active
- **THEN** the backend leaves the child running and records that the parent no longer awaits the result

#### Scenario: Detached child finishes
- **WHEN** a child finishes after its supervisor is terminal
- **THEN** the backend stores the result with detached or ignored status and does not continue the supervisor

### Requirement: Review merge fixed test gate
The system SHALL require `review_merge` to run a configured fixed test command before accepting applied changes.

#### Scenario: Tests pass after apply
- **WHEN** `review_merge` applies changes to the supervisor workspace and the fixed test command passes
- **THEN** the merge outcome is recorded as `merged` with test evidence

#### Scenario: Tests fail after apply
- **WHEN** `review_merge` applies changes and the fixed test command fails
- **THEN** the backend requires the supervisor workspace to be reverted and records `test_failed_reverted` when revert verification passes

#### Scenario: Conflict prevents apply
- **WHEN** `review_merge` cannot apply changes because of conflicts
- **THEN** the merge outcome is recorded as `conflict` and no revert is required

### Requirement: Backend merge verification
The system SHALL verify review-merge claims before reporting the outcome to the supervisor.

#### Scenario: Merge verification succeeds
- **WHEN** `review_merge` reports a merge outcome
- **THEN** the backend verifies the workspace checkpoint, diff summary, and required test or revert evidence before accepting the outcome

#### Scenario: Merge verification fails
- **WHEN** required merge evidence is missing or the supervisor workspace does not match the reported state
- **THEN** the backend records `verification_failed` and returns the failure summary to the supervisor
