# goal-state-persistence Specification

## Purpose

Define how goal lifecycle state is durably persisted in SQLite as the local source of truth for the vertical-slice MVP, including goals, runs, steps, events, and database configuration.

## Requirements

### Requirement: SQLite persists lifecycle state
The system SHALL persist goals, runs, steps, and events in SQLite as the durable local source of truth.

#### Scenario: State survives restart
- **WHEN** the backend restarts after a goal has been created and started
- **THEN** the persisted goal and its event timeline remain available from the backend API

### Requirement: Goals are persisted with domain fields
The system SHALL persist goal records with id, title, description, status, priority, agent type, created timestamp, updated timestamp, started timestamp, and completed timestamp.

#### Scenario: Created goal has persisted metadata
- **WHEN** the backend creates a goal
- **THEN** SQLite stores the goal with the required domain fields and a `draft` status

### Requirement: Runtime records are persisted
The system SHALL persist run and step records created by the mock runtime even if the first dashboard does not query them directly.

#### Scenario: Started goal records runtime internals
- **WHEN** a goal is started
- **THEN** SQLite stores the associated run and step records used by the mock runtime lifecycle

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
