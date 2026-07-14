## ADDED Requirements

### Requirement: Dashboard shows compact authoritative live status
The dashboard SHALL show one compact current-activity panel for a goal above
the existing managed-session details and durable event timeline.

#### Scenario: Active pipeline phase is visible
- **WHEN** live status reports Supervisor, continuation, Worker, Judge,
  Integrator, re-Judge, delivery, validation, rollback, approval, or user-input activity
- **THEN** the dashboard displays a human-readable state and phase without requiring timeline inference

#### Scenario: Runtime context is known
- **WHEN** provider/model, role, task, or last activity is present
- **THEN** the compact panel displays those safe fields

#### Scenario: Goal reaches terminal state
- **WHEN** the snapshot reports completed, failed, blocked, or cancelled
- **THEN** the panel displays the terminal state even if older child/session records remain nonterminal

### Requirement: Dashboard status remains compatible with partial metadata
The dashboard SHALL render compact live status when optional runtime metadata is
absent or contains a future unknown value.

#### Scenario: Historical goal has no runtime identities
- **WHEN** live status has no session, delegation, parent, role, task, or integration identifiers
- **THEN** the dashboard renders known state, phase, summary, and time without error

#### Scenario: Detailed views already exist
- **WHEN** compact status and detailed managed-session/task data are both returned
- **THEN** the dashboard keeps the detailed controls and timeline and does not duplicate their full contents in the compact panel
