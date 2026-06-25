## ADDED Requirements

### Requirement: Dashboard receives live goal events without polling
The system SHALL allow the dashboard to receive backend-pushed timeline events for a running goal without using periodic polling.

#### Scenario: Live event stream appends running events
- **WHEN** a user opens a running goal detail view
- **THEN** the dashboard subscribes to a backend event stream for that goal
- **AND** newly persisted goal events appear in the timeline without waiting for a manual refresh

#### Scenario: Snapshot remains the reconnect source of truth
- **WHEN** the dashboard opens or reconnects a goal timeline
- **THEN** it first loads the durable event snapshot through the existing events endpoint
- **AND** it deduplicates streamed events by event id when appending live updates

### Requirement: Dashboard does not poll for live timeline updates
The system SHALL NOT use a repeated timer or polling loop to update the running goal timeline.

#### Scenario: Running goal timeline is live
- **WHEN** a goal is running and the dashboard is displaying its timeline
- **THEN** live updates arrive through a pushed backend stream rather than repeated calls to the snapshot events endpoint

### Requirement: Live stream terminates cleanly at goal terminal state
The system SHALL allow the dashboard to stop listening for live events once the goal reaches a terminal state.

#### Scenario: Goal completes while stream is open
- **WHEN** a streamed event indicates the goal completed, failed, blocked, or was cancelled
- **THEN** the dashboard renders the terminal event and closes or stops relying on the live stream for that goal
