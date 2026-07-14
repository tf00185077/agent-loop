## ADDED Requirements

### Requirement: Child event-consumption failures are durable

The system SHALL treat the child event-consumption loop as an observed
operation: any failure that would otherwise escape the loop unhandled (an
unhandled promise rejection or thrown error not already recorded through the
normal durable-event path) SHALL be recorded as a durable failure event scoped
to the affected delegation and child session, rather than surfacing only as an
unobserved promise rejection.

This requirement is an outermost safety net around child event consumption. It
SHALL NOT change the outcome of delegations that complete, fail, cancel, time
out, or detach through the normal recorded path, and it SHALL NOT double-record
a failure that was already persisted durably.

#### Scenario: Child consumption loop rejects without a durable trace

- **WHEN** the child event-consumption loop for a delegation rejects with an
  error that was not already recorded through the normal durable-event path
- **THEN** the backend persists a durable failure event that identifies the
  affected delegation request and child session

#### Scenario: Normal child outcomes are unaffected

- **WHEN** a child delegation reaches a terminal outcome through the normal
  recorded path (completed, failed, cancelled, timed out, or detached)
- **THEN** the outermost safety net adds no additional failure event and leaves
  the recorded delegation outcome unchanged
