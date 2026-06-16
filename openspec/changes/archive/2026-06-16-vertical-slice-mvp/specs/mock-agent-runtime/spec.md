## ADDED Requirements

### Requirement: Mock runtime starts goals
The system SHALL run a mock in-process lifecycle when a persisted draft goal is started.

#### Scenario: Start creates run
- **WHEN** the backend receives a valid start request for a draft goal
- **THEN** it creates a run for the goal and records a `run.started` event

### Requirement: Mock runtime records steps
The system SHALL create and update persisted steps during the mock goal lifecycle.

#### Scenario: Runtime completes a step
- **WHEN** the mock runtime performs a unit of work
- **THEN** it records step start and completion state along with corresponding events

### Requirement: Mock runtime records agent messages
The system SHALL record mock agent progress messages as durable events.

#### Scenario: Agent message is visible through events
- **WHEN** the mock runtime emits a progress message
- **THEN** the event timeline includes an `agent.message` event for the goal

### Requirement: Mock runtime reaches terminal goal state
The system SHALL update the goal and run to a terminal state when the mock lifecycle finishes.

#### Scenario: Goal completes successfully
- **WHEN** the mock runtime completes its planned work
- **THEN** the goal status becomes `completed`, the run status becomes `completed`, and completion events are recorded

### Requirement: Mock runtime can block goals
The system SHALL support a blocked terminal path for the mock lifecycle.

#### Scenario: Goal becomes blocked
- **WHEN** the mock runtime determines the goal cannot proceed
- **THEN** the goal status becomes `blocked` and a `goal.blocked` event is recorded

### Requirement: Runtime stays backend-owned
The system SHALL keep runtime behavior and provider configuration behind the backend API boundary.

#### Scenario: Dashboard starts but does not execute runtime
- **WHEN** the dashboard starts a goal
- **THEN** it only calls the backend start endpoint and does not directly run agent logic or use provider credentials

