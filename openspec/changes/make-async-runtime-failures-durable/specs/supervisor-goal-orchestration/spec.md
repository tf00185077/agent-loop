## ADDED Requirements

### Requirement: Background supervisor run failures are durable

The system SHALL treat the goal's background supervisor run as an observed
operation: any failure that would otherwise escape the background run
unhandled (an unhandled promise rejection or thrown error not already recorded
through the normal durable-event path) SHALL be recorded as a durable failure
event for the goal and SHALL transition the goal to a durable terminal failure
status, rather than being reported only through a console log.

This requirement is an outermost safety net. Failures that the runtime already
records durably through its normal event flow SHALL NOT be double-recorded, and
the goal status SHALL end in a terminal failure state exactly once.

#### Scenario: Background run rejects without a durable trace

- **WHEN** a goal's background supervisor run rejects with an error that was not
  already recorded through the normal durable-event path
- **THEN** the backend persists a durable failure event for the goal and
  transitions the goal to a terminal failure status

#### Scenario: Already-durable failure is not double-recorded

- **WHEN** a goal's background supervisor run ends after the runtime has already
  recorded the failure durably and set a terminal goal status
- **THEN** the outermost safety net adds no duplicate failure event and does not
  change the already-terminal goal status
