## ADDED Requirements

### Requirement: Dashboard shows compact live status
The dashboard SHALL show a compact current activity status for a goal in addition to the durable event timeline.

#### Scenario: Active run has current activity
- **WHEN** a goal detail view is open for a running goal with observation activity
- **THEN** the dashboard displays the current state, last activity, provider/model when known, and safe activity summary

#### Scenario: Active run is stalled
- **WHEN** the derived live status indicates no recent activity or stalled work
- **THEN** the dashboard displays a visible stalled or quiet-running indication without requiring the user to inspect raw timeline events

#### Scenario: Goal reaches terminal state
- **WHEN** a streamed or snapshot event indicates completion, failure, or blocked state
- **THEN** the dashboard updates the compact live status to the terminal state

### Requirement: Dashboard status tolerates partial metadata
The dashboard SHALL render live status when optional future orchestration metadata is absent or incomplete.

#### Scenario: Single-agent status has no parent
- **WHEN** live status includes provider/model but no agent id, parent agent id, or task id
- **THEN** the dashboard renders the status without error

#### Scenario: Unknown status details appear
- **WHEN** live status includes an unknown source or future status detail
- **THEN** the dashboard displays known safe fields and does not fail the goal detail view
