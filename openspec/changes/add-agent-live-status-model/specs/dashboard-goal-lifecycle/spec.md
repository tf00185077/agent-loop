## ADDED Requirements

### Requirement: Dashboard shows minimal live status
The dashboard SHALL show a compact current activity status for a goal in addition to the durable event timeline.

#### Scenario: Active run has current activity
- **WHEN** a goal detail view is open for a running goal with runtime activity
- **THEN** the dashboard displays the current state, last activity, provider/model when known, and safe activity summary

#### Scenario: Supervisor waits on child
- **WHEN** the derived live status indicates `waiting_child`
- **THEN** the dashboard displays that the supervisor is waiting for child work instead of requiring the user to infer it from raw timeline events

#### Scenario: Goal reaches terminal state
- **WHEN** a snapshot or event indicates completion, failure, blocked, or cancellation state
- **THEN** the dashboard updates the compact live status to the terminal state

### Requirement: Dashboard status tolerates partial metadata
The dashboard SHALL render minimal live status when optional orchestration metadata is absent or incomplete.

#### Scenario: Single-agent status has no parent
- **WHEN** live status includes provider/model but no agent id, parent agent id, or task id
- **THEN** the dashboard renders the status without error

#### Scenario: Unknown status details appear
- **WHEN** live status includes an unknown source or future status detail
- **THEN** the dashboard displays known safe fields and does not fail the goal detail view
