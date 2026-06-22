# dashboard-goal-lifecycle Specification

## Purpose

Define the dashboard-facing goal lifecycle for the vertical-slice MVP: how a local user creates, lists, views, starts, and observes goals through a minimal backend API surface.
## Requirements
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

### Requirement: Dashboard shows saved provider test progress
The dashboard SHALL show connection-test progress and the resulting provider status when Codex Local settings are automatically tested after save.

#### Scenario: Auto-test is running
- **WHEN** the dashboard has saved Codex Local provider settings and the automatic connection test is in progress
- **THEN** provider setup shows a testing state separate from the save action
- **AND** the user can tell the selected model is being validated

#### Scenario: Auto-test result is shown
- **WHEN** the automatic Codex Local connection test completes
- **THEN** provider setup shows the sanitized success or failure status returned by the backend

### Requirement: Dashboard identifies run provider and model
The dashboard SHALL display available provider and model metadata for goal runs and timeline events so users can tell which provider/model produced a run, response, or error.

#### Scenario: Goal detail shows latest run metadata
- **WHEN** a goal has durable events containing provider/model metadata for a run
- **THEN** the goal detail view shows the latest available provider and model for that goal

#### Scenario: Timeline shows event run metadata
- **WHEN** the event timeline renders an event with provider/model metadata
- **THEN** the timeline displays that metadata near the event type or message

#### Scenario: Missing metadata is tolerated
- **WHEN** historical events or generic lifecycle events do not include provider/model metadata
- **THEN** the dashboard still renders the timeline without an error

### Requirement: Dashboard uses minimal MVP API
The system SHALL support the first dashboard demo path with only goal creation, goal list, goal detail, goal start, and goal events API endpoints.

#### Scenario: Run and step query APIs are not required
- **WHEN** the dashboard shows the first MVP lifecycle
- **THEN** it does not require `GET /api/runs/:id`, `GET /api/goals/:id/steps`, pause, cancel, retry, or resume endpoints

### Requirement: Dashboard starts goals with current provider selection
The dashboard SHALL send the currently selected provider/model state when the user starts a draft goal, without requiring the user to save that selection first.

#### Scenario: User starts with unsaved Codex model selection
- **WHEN** the user selects Codex Local and a catalog model in provider setup but does not press Save
- **AND** the user starts a draft goal
- **THEN** the start request includes the selected Codex provider, model label, and command path for that run

#### Scenario: User starts with saved defaults only
- **WHEN** the dashboard has no current provider override state for a start action
- **THEN** starting a draft goal still works using saved provider settings

### Requirement: Save remains a persistent default action
The dashboard SHALL keep Save as the action that persists provider defaults, separate from the per-run start selection.

#### Scenario: User changes model and starts without saving
- **WHEN** the user changes the selected model and starts a goal without pressing Save
- **THEN** the run uses the selected model
- **AND** the persisted provider settings remain unchanged

### Requirement: Goal detail shows actual run provider metadata
The dashboard SHALL display provider/model metadata from the actual run events, not from the saved provider setup defaults.

#### Scenario: Run uses per-run override
- **WHEN** a goal was started with a provider override
- **THEN** the goal detail and timeline show the provider/model metadata recorded for that run

