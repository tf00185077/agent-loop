## MODIFIED Requirements

### Requirement: Review and delivery decisions are durable
The system SHALL persist structured Judge verdicts, conditional integration attempts, and backend delivery outcomes as first-class records linked to the worker attempt and exact candidate identity they concern.

#### Scenario: Accepted review is persisted
- **WHEN** the Judge accepts every criterion for a worker or resolved integration candidate
- **THEN** the backend stores the Judge identity, reviewed candidate SHA when available, integration attempt when present, overall verdict, per-criterion decisions, cited criteria, and safe summary

#### Scenario: Integration attempt is persisted
- **WHEN** backend delivery enters conditional conflict recovery
- **THEN** it stores the task and delegation identities, lifecycle status, checkpoint SHA, original and resolved candidate SHAs when present, conflict and allowed files, bounded summaries, and timestamps before acknowledging each transition

#### Scenario: Delivery outcome is persisted
- **WHEN** the backend applies, validates, commits, rejects, integrates, or rolls back a reviewed attempt
- **THEN** it stores the delivery status, checkpoint, candidate and integration identities, validation evidence, resulting commit SHA when present, and rollback evidence when required

## ADDED Requirements

### Requirement: Durable integration state fails closed across restart
The system SHALL project integration attempts and candidate-bound re-review state from SQLite and SHALL NOT duplicate automatic recovery or infer acceptance after restart.

#### Scenario: Restart after resolved candidate creation
- **WHEN** the database reopens after a resolved candidate was persisted but before a valid candidate-bound re-review completed
- **THEN** durable context reports pending re-review and the resolved candidate cannot satisfy delivery

#### Scenario: Restart loses active Integrator process
- **WHEN** a nonterminal Integrator child cannot be truly resumed after restart
- **THEN** the backend records an interrupted terminal outcome, preserves the one-attempt bound, and returns the gap to the Supervisor
