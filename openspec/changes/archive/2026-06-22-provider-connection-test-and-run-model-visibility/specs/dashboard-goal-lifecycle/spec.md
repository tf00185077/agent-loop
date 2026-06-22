## ADDED Requirements

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
