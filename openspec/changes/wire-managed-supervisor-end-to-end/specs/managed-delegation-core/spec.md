# managed-delegation-core Specification (Delta)

## ADDED Requirements

### Requirement: Sequential delegations across supervisor lifetime
The system SHALL allow a supervisor session to issue multiple delegation requests sequentially over its lifetime, while still enforcing at most one active child at a time and maximum depth one.

#### Scenario: Second delegation after first child completes
- **WHEN** a supervisor whose previous child delegation reached a terminal state emits a new valid delegation request
- **THEN** the backend accepts the new request and starts the next child session

#### Scenario: Delegation requests preserve order
- **WHEN** multiple delegation requests have been recorded for one supervisor
- **THEN** the persisted requests reconstruct the delegation sequence in order with their roles, task identifiers when present, statuses, and result summaries

### Requirement: Managed goal completion requires supervisor completion signal
The system SHALL complete a managed supervisor goal only on an explicit supervisor completion signal or a terminal failure, cancellation, or configured bound; a supervisor provider process exiting SHALL NOT by itself mark the goal completed.

#### Scenario: Supervisor process exits mid-goal
- **WHEN** a supervisor session's provider process exits without a completion signal while no delegation is pending
- **THEN** the goal remains non-terminal and the backend starts a bounded supervisor continuation

#### Scenario: Completion signal completes the goal
- **WHEN** the supervisor emits a valid completion signal
- **THEN** the backend marks the supervisor session, run, and goal completed and records the safe result summary

### Requirement: Bounded completion-less continuations
The system SHALL enforce a configured maximum number of supervisor continuations started because a session ended without a completion signal, and SHALL mark the goal blocked with a durable reason when the bound is reached.

#### Scenario: Continuation bound is exhausted
- **WHEN** completion-less supervisor continuations reach the configured maximum
- **THEN** the backend marks the goal blocked, records the bound and reason durably, and starts no further continuations
