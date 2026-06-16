## ADDED Requirements

### Requirement: Dashboard creates goals
The system SHALL allow a local user to create a goal from the dashboard by submitting a title, description, priority, and agent type.

#### Scenario: Goal is created from dashboard
- **WHEN** the user submits a valid goal creation form
- **THEN** the backend persists the goal and the dashboard can show the new goal in the goal list

### Requirement: Dashboard lists goals
The system SHALL allow the dashboard to list persisted goals with enough information to identify each goal and its current status.

#### Scenario: Goals are visible after refresh
- **WHEN** a user refreshes the dashboard after creating a goal
- **THEN** the goal list still shows the persisted goal and its current status

### Requirement: Dashboard shows goal detail
The system SHALL allow the dashboard to show a single goal's title, description, status, priority, agent type, and lifecycle timestamps.

#### Scenario: User opens goal detail
- **WHEN** the user selects a goal from the goal list
- **THEN** the dashboard shows that goal's persisted detail snapshot

### Requirement: Dashboard starts goals
The system SHALL allow the dashboard to start a persisted goal through a backend action endpoint.

#### Scenario: User starts a draft goal
- **WHEN** the user starts a draft goal from the goal detail view
- **THEN** the backend starts the mock runtime lifecycle for that goal and records durable progress events

### Requirement: Dashboard shows event timeline
The system SHALL allow the dashboard to display a goal's durable event timeline without requiring dedicated run or step query APIs.

#### Scenario: Timeline shows lifecycle progress
- **WHEN** a started goal has runtime events
- **THEN** the dashboard shows the goal's event timeline in creation order

### Requirement: Dashboard uses minimal MVP API
The system SHALL support the first dashboard demo path with only goal creation, goal list, goal detail, goal start, and goal events API endpoints.

#### Scenario: Run and step query APIs are not required
- **WHEN** the dashboard shows the first MVP lifecycle
- **THEN** it does not require `GET /api/runs/:id`, `GET /api/goals/:id/steps`, pause, cancel, retry, or resume endpoints

