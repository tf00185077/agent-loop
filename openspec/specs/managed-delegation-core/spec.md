# managed-delegation-core Specification

## Purpose

Define the durable backend-managed delegation core for supervisor and worker sessions, including delegation request state, one-active-child enforcement, child outcome recording, supervisor continuation, and detached child result handling.

## Requirements
### Requirement: Durable delegation request state
The system SHALL persist backend-managed delegation requests as first-class durable state separate from parent-child session metadata.

#### Scenario: Delegation request is accepted
- **WHEN** a running supervisor emits a valid delegation control event
- **THEN** the backend persists a delegation request linked to the supervisor session and records an accepted status

#### Scenario: Delegation request survives restart
- **WHEN** the backend reloads after a delegation request was accepted
- **THEN** the persisted request identifies the parent session, child session when created, role, status, timestamps, and latest safe summary without reading provider output

### Requirement: One active child per supervisor
The system SHALL allow at most one active child delegation for a supervisor session in v1.

#### Scenario: Active child exists
- **WHEN** a supervisor with an active child emits another valid delegation request
- **THEN** the backend rejects the new request and records a safe rejection reason

### Requirement: Maximum delegation depth
The system SHALL reject nested delegation in v1.

#### Scenario: Child requests child
- **WHEN** a child session emits a delegation request
- **THEN** the backend rejects the request and records that maximum delegation depth has been reached

### Requirement: Worker child session spawning
The system SHALL spawn accepted `worker` child sessions through backend-managed runtime APIs.

#### Scenario: Worker child starts
- **WHEN** the backend accepts a `worker` delegation request
- **THEN** it creates a child agent session linked to the supervisor and records a durable delegation-started event

### Requirement: Child outcomes
The system SHALL record child success, failure, timeout, and cancellation outcomes without automatically failing the supervisor goal.

#### Scenario: Child succeeds
- **WHEN** a child session completes successfully
- **THEN** the backend records the child result summary and marks the delegation request completed

#### Scenario: Child fails
- **WHEN** a child session fails, times out, or is cancelled
- **THEN** the backend records the failure summary and keeps the supervisor goal eligible for continuation

### Requirement: Supervisor continuation after child result
The system SHALL return non-detached child outcomes to the supervisor as observations and continue the supervisor.

#### Scenario: Provider supports true resume
- **WHEN** a child result is recorded and the supervisor provider supports true resume
- **THEN** the backend resumes the supervisor session with the child result observation

#### Scenario: Provider lacks true resume
- **WHEN** a child result is recorded and true resume is unavailable
- **THEN** the backend starts a fresh supervisor continuation with summarized child result context

### Requirement: Detached child outcomes
The system SHALL preserve active child execution when the supervisor becomes terminal and mark late child results as detached or ignored.

#### Scenario: Supervisor cancelled while child runs
- **WHEN** the supervisor is cancelled while a child session remains active
- **THEN** the backend records that the supervisor no longer awaits the child result and leaves the child running

#### Scenario: Child finishes after supervisor terminal state
- **WHEN** a child finishes after its supervisor is terminal
- **THEN** the backend stores the child outcome as detached or ignored and does not continue the supervisor

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
