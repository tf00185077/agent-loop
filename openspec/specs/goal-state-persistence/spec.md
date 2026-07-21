# goal-state-persistence Specification

## Purpose

Define how goal lifecycle state is durably persisted in SQLite as the local source of truth for the vertical-slice MVP, including goals, runs, steps, events, and database configuration.
## Requirements
### Requirement: SQLite persists lifecycle state
The system SHALL persist goals, runs, steps, managed sessions, delegation attempts, managed tasks, frozen criteria, criterion outcomes, judge reviews, delivery outcomes, and events in SQLite as the durable local source of truth.

#### Scenario: State survives restart
- **WHEN** the backend restarts after a managed goal has registered tasks or progressed through attempts, reviews, or delivery
- **THEN** the persisted lifecycle and task acceptance state remain available without reinterpreting prior AI response text

#### Scenario: Runtime gate reads reopened state
- **WHEN** a delegation, retry, review, delivery, or completion decision occurs after reopening SQLite
- **THEN** the gate produces the same result it would have produced from the last committed state before restart

### Requirement: Goals are persisted with domain fields
The system SHALL persist goal records with id, title, description, status, priority, agent type, an optional workspace directory, created timestamp, updated timestamp, started timestamp, and completed timestamp. A goal with no workspace SHALL read back as using the server's default workspace.

#### Scenario: Created goal has persisted metadata
- **WHEN** the backend creates a goal
- **THEN** SQLite stores the goal with the required domain fields and a `draft` status

#### Scenario: Workspace persists and defaults
- **WHEN** a goal is created with a workspace directory
- **THEN** SQLite stores that workspace, and a goal created without one reads back with a null workspace that resolves to the server default

### Requirement: Runtime records are persisted
The system SHALL persist run and step records for iterative runtimes and SHALL persist session, delegation-attempt, managed-task, criterion, review, and delivery records for managed runtimes even when the dashboard does not query each record directly.

#### Scenario: Started iterative goal records runtime internals
- **WHEN** an iterative goal is started
- **THEN** SQLite stores the associated run and step records used by its lifecycle

#### Scenario: Managed task advances
- **WHEN** a managed task is registered, delegated, reviewed, delivered, retried, split, blocked, failed, or accepted
- **THEN** SQLite stores the aggregate state and linked records needed to continue and evaluate completion

### Requirement: Events are persisted for observability
The system SHALL persist events as the dashboard's first observability surface.

#### Scenario: Goal lifecycle writes events
- **WHEN** a goal is created and started
- **THEN** SQLite stores durable events for meaningful lifecycle actions

### Requirement: Database path is configurable
The system SHALL allow the SQLite database path to be configured while providing a local default path.

#### Scenario: Default database path is used
- **WHEN** no custom database path is configured
- **THEN** the backend uses a local default path such as `data/auto-agent.sqlite`

### Requirement: State transitions and audit events are atomic
The system SHALL update decision-critical managed state and append its corresponding sanitized event within one SQLite transaction.

#### Scenario: Durable transition succeeds
- **WHEN** the transaction committing a task, criterion, review, delivery, or completion transition succeeds
- **THEN** both the current-state projection and its audit event are visible

#### Scenario: Durable transition fails
- **WHEN** any write in the transition transaction fails
- **THEN** neither the state transition nor its audit event is committed
