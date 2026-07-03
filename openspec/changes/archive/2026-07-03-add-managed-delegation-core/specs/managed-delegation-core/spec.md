## ADDED Requirements

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
