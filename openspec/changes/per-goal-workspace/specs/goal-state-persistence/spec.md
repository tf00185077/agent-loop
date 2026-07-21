# goal-state-persistence Delta

## MODIFIED Requirements

### Requirement: Goals are persisted with domain fields
The system SHALL persist goal records with id, title, description, status, priority, agent type, an optional workspace directory, created timestamp, updated timestamp, started timestamp, and completed timestamp. A goal with no workspace SHALL read back as using the server's default workspace.

#### Scenario: Created goal has persisted metadata
- **WHEN** the backend creates a goal
- **THEN** SQLite stores the goal with the required domain fields and a `draft` status

#### Scenario: Workspace persists and defaults
- **WHEN** a goal is created with a workspace directory
- **THEN** SQLite stores that workspace, and a goal created without one reads back with a null workspace that resolves to the server default
