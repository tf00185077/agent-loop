## ADDED Requirements

### Requirement: Live status is derived from durable events
The system SHALL derive a goal's current agent activity status from durable goal events and structured agent observation events.

#### Scenario: Status is reconstructed after refresh
- **WHEN** the dashboard reloads after observation events were persisted
- **THEN** the backend can derive the current live status from the durable event snapshot
- **AND** no active SSE connection or in-memory provider process state is required

#### Scenario: Streamed event updates status
- **WHEN** a new observation event is streamed for the goal
- **THEN** the dashboard can update the derived live status without manual refresh

### Requirement: Live status identifies current activity
The system SHALL expose safe current activity fields that help the user understand what the active agent is doing.

#### Scenario: Command is running
- **WHEN** the latest relevant observation indicates a command started and no matching terminal command observation has arrived
- **THEN** the live status includes a running state, the safe command summary, and the last activity time

#### Scenario: Command completes
- **WHEN** a command-completed observation arrives
- **THEN** the live status clears the current command
- **AND** updates the safe summary and last activity time

#### Scenario: Provider emits generic progress
- **WHEN** a provider emits a sanitized progress observation
- **THEN** the live status updates last activity and safe summary without requiring message parsing

### Requirement: Live status represents quiet and stalled runs
The system SHALL distinguish quiet-but-running work from stalled work using durable activity timestamps and configured thresholds.

#### Scenario: Running provider is recently active
- **WHEN** a goal has a non-terminal run and recent observation activity
- **THEN** the live status is running or idle rather than stalled

#### Scenario: Running provider has no recent activity
- **WHEN** a goal has a non-terminal run and no observation activity within the configured stale interval
- **THEN** the live status indicates stalled or no recent activity

### Requirement: Waiting and failure causes are safe
The system SHALL represent known waiting, blocked, timeout, and failure causes using safe summaries from observation or terminal events.

#### Scenario: Provider waits for user action
- **WHEN** an observation indicates approval, login, sandbox, tool, or network waiting state
- **THEN** the live status exposes a waiting state with a sanitized reason

#### Scenario: Provider fails
- **WHEN** a command-failed, provider-failed, timeout, blocked, or error event arrives
- **THEN** the live status exposes a failed or blocked terminal state with a sanitized summary

### Requirement: Optional agent metadata is tolerated
The system SHALL support agent and task metadata in live status while remaining compatible with single-agent runs.

#### Scenario: Agent metadata is present
- **WHEN** observations include agent id, agent role, parent agent id, or task id
- **THEN** the live status includes those identifiers in the derived view

#### Scenario: Agent metadata is absent
- **WHEN** current single-agent observations do not include future orchestration metadata
- **THEN** the live status still renders using goal/run/provider context
