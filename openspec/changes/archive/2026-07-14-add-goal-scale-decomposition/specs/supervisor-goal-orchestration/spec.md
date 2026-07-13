# supervisor-goal-orchestration Specification (Delta)

## ADDED Requirements

### Requirement: Scale assessment in the bootstrap contract
The supervisor bootstrap prompt SHALL document goal scale assessment: the change-plan control block format, sizing guidance for when to split a goal into multiple changes, and the rule that small goals proceed with a flat task list.

#### Scenario: Bootstrap documents the change plan
- **WHEN** a managed goal starts
- **THEN** the bootstrap prompt contains the `managed_change.plan` format with an example and sizing guidance for choosing between a flat task list and a change plan

### Requirement: Task decomposition references the active change
The system SHALL associate task lists and worker delegations announced under a change plan with the active change identifier, inheriting it when absent and rejecting explicit mismatches.

#### Scenario: Task list inherits the active change
- **WHEN** a supervisor announces a task list while a change is active without naming a change
- **THEN** the registered tasks carry the active change identifier in durable metadata

#### Scenario: Mismatched change reference is rejected
- **WHEN** a task list or worker delegation names a change other than the active one
- **THEN** the backend rejects it with a safe reason naming the active change

### Requirement: Continuations carry change-level history
The system SHALL render change-plan state into supervisor continuation and nudge prompts when a plan exists: each change's identifier, title, status, and the active change's task summary.

#### Scenario: Continuation shows plan progress
- **WHEN** a supervisor continuation starts for a goal with a change plan
- **THEN** the prompt lists every planned change with its status and identifies the active change alongside the existing task history
