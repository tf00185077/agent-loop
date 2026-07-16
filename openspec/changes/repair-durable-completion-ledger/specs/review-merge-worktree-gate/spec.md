## ADDED Requirements

### Requirement: Delivery obligation follows authoritative candidate disposition
The system SHALL derive each delivery obligation from a Goal-scoped, task-scoped, candidate-bound authoritative Judge decision. An accepted candidate with backend-attested workspace changes SHALL require a matching committed backend delivery while it remains current delivery-authorized work. A Judge-rejected, blocked, malformed, abandoned, or superseded historical candidate SHALL NOT create a permanent delivery obligation, and its audit history SHALL remain durable.

#### Scenario: Accepted changed candidate awaits delivery
- **WHEN** the Judge accepts the exact current candidate and the worker attempt has backend-attested workspace changes
- **THEN** completion reports a delivery gap until backend delivery for that candidate is committed

#### Scenario: Rejected changed candidate is not deliverable
- **WHEN** the Judge rejects or blocks a candidate that has backend-attested workspace changes
- **THEN** the backend does not apply or commit that candidate
- **AND** completion does not report that candidate as an undelivered delivery obligation

#### Scenario: Accepted delivery satisfies the obligation
- **WHEN** backend delivery commits the exact candidate authorized by the accepted Judge decision
- **THEN** that candidate has no remaining delivery obligation

#### Scenario: Accepted retry supersedes a rejected attempt
- **WHEN** an earlier changed attempt was rejected and a later attempt for the same task is accepted and committed
- **THEN** the task can satisfy completion without a delivery record for the rejected attempt
- **AND** both attempts and their review evidence remain queryable

#### Scenario: Later committed candidate supersedes terminal prior work
- **WHEN** an earlier candidate reached a terminal non-committed disposition and a later exact candidate for the same task is accepted and committed
- **THEN** the earlier terminal candidate does not remain an open delivery obligation
- **AND** any still-active review, integration, or delivery remains a separate completion gap

#### Scenario: Resolved integration candidate remains identity bound
- **WHEN** integration produces a resolved candidate after an accepted original candidate conflicts
- **THEN** only a fresh Judge acceptance and committed delivery bound to the resolved candidate satisfy its delivery obligation
