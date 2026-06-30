## ADDED Requirements

### Requirement: Minimal live status is derived from durable events
The system SHALL derive a goal's current MVP agent activity status from durable goal, run, and agent events.

#### Scenario: Status is reconstructed after refresh
- **WHEN** the dashboard reloads after runtime events were persisted
- **THEN** the backend can derive the current live status from the durable event snapshot
- **AND** no active SSE connection or in-memory provider process state is required

### Requirement: Minimal live status identifies MVP control state
The system SHALL expose safe current activity fields that help the user understand whether the MVP delegation loop is running, waiting, continuing, or terminal.

#### Scenario: Supervisor waits on child
- **WHEN** the latest relevant control-plane event indicates the supervisor is waiting for a child result
- **THEN** the live status includes `waiting_child`, the parent/child relationship metadata when available, and the last activity time

#### Scenario: Supervisor continues after child
- **WHEN** a child result is recorded and a supervisor continuation starts
- **THEN** the live status includes `continuing` with a safe result summary when available

#### Scenario: Goal reaches terminal state
- **WHEN** the durable events indicate completed, failed, blocked, or cancelled state
- **THEN** the live status exposes the matching terminal state with a sanitized summary

### Requirement: Optional agent metadata is tolerated
The system SHALL support agent and task metadata in live status while remaining compatible with single-agent runs.

#### Scenario: Agent metadata is present
- **WHEN** observations include agent id, agent role, parent agent id, or task id
- **THEN** the live status includes those identifiers in the derived view

#### Scenario: Agent metadata is absent
- **WHEN** current single-agent observations do not include orchestration metadata
- **THEN** the live status still renders using goal/run/provider context
