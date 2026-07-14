## MODIFIED Requirements

### Requirement: SQLite persists lifecycle state
The system SHALL persist goals, runs, steps, managed sessions, delegation attempts, managed tasks, frozen criteria, criterion outcomes, judge reviews, delivery outcomes, and events in SQLite as the durable local source of truth.

#### Scenario: State survives restart
- **WHEN** the backend restarts after a managed goal has registered tasks or progressed through attempts, reviews, or delivery
- **THEN** the persisted lifecycle and task acceptance state remain available without reinterpreting prior AI response text

#### Scenario: Runtime gate reads reopened state
- **WHEN** a delegation, retry, review, delivery, or completion decision occurs after reopening SQLite
- **THEN** the gate produces the same result it would have produced from the last committed state before restart

### Requirement: Runtime records are persisted
The system SHALL persist run and step records for iterative runtimes and SHALL persist session, delegation-attempt, managed-task, criterion, review, and delivery records for managed runtimes even when the dashboard does not query each record directly.

#### Scenario: Started iterative goal records runtime internals
- **WHEN** an iterative goal is started
- **THEN** SQLite stores the associated run and step records used by its lifecycle

#### Scenario: Managed task advances
- **WHEN** a managed task is registered, delegated, reviewed, delivered, retried, split, blocked, failed, or accepted
- **THEN** SQLite stores the aggregate state and linked records needed to continue and evaluate completion

## ADDED Requirements

### Requirement: State transitions and audit events are atomic
The system SHALL update decision-critical managed state and append its corresponding sanitized event within one SQLite transaction.

#### Scenario: Durable transition succeeds
- **WHEN** the transaction committing a task, criterion, review, delivery, or completion transition succeeds
- **THEN** both the current-state projection and its audit event are visible

#### Scenario: Durable transition fails
- **WHEN** any write in the transition transaction fails
- **THEN** neither the state transition nor its audit event is committed


