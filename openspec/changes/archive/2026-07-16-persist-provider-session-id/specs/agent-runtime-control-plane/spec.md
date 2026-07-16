## ADDED Requirements

### Requirement: Provider-native session id is durably recorded

The system SHALL durably record the provider-native session id for a managed
session when the provider reports one, storing it on the durable session record
so recovery and resume can reference it. The id SHALL be captured from a session
event's metadata the first time it is observed and SHALL NOT change session
execution behavior; a provider that reports no session id leaves the record's
provider session id absent.

#### Scenario: Provider session id is captured and persisted

- **WHEN** a managed session emits an event carrying a provider-native session id
- **THEN** the backend records that id on the durable session record and later
  reads it back without re-reading provider output

#### Scenario: No provider session id is reported

- **WHEN** a managed session runs without the provider reporting a session id
- **THEN** the durable session record's provider session id remains absent and
  the session executes unchanged
