# durable-managed-task-state Specification

## Purpose
TBD - created by archiving change add-durable-task-completion-gate. Update Purpose after archive.
## Requirements
### Requirement: Managed tasks are first-class durable state
The system SHALL persist each supervisor-announced managed task in SQLite with its goal, optional change, optional parent task, title, current status, attempt count, substantive rejection count, last cited criteria, last safe summary, and timestamps.

#### Scenario: Task list creates durable tasks
- **WHEN** the backend accepts a supervisor task-list control block
- **THEN** it persists each task and its lineage before acknowledging the task list
- **AND** the same task state remains queryable after the database is reopened

#### Scenario: Task transition updates state and audit together
- **WHEN** a managed task changes status or counters
- **THEN** the backend updates its durable state and appends the corresponding sanitized event atomically

### Requirement: Worker delegations are durable task attempts
The system SHALL associate every contracted worker delegation with a monotonically increasing attempt number for its task and SHALL preserve the attempt lifecycle, child session, structured result, attested files, tests, and safe summary.

#### Scenario: Retry creates a new attempt
- **WHEN** a worker is delegated a task that has a prior attempt
- **THEN** the new delegation receives the next attempt number without overwriting prior attempt evidence

#### Scenario: Restart preserves retry bounds
- **WHEN** the backend restarts after one or more attempts or substantive rejections
- **THEN** the next delegation gate uses the persisted counts and enforces the same retry or narrowing decision as before restart

### Requirement: Criterion definitions and outcomes are durable and distinct
The system SHALL persist immutable criterion id/text definitions separately from attempt-scoped evidence and authoritative outcomes, and each required criterion outcome SHALL be one of `UNKNOWN`, `PASS`, `FAIL`, or `BLOCKED`.

#### Scenario: Executor evidence remains a claim
- **WHEN** a worker reports evidence for a criterion
- **THEN** the backend stores the claim on that attempt without changing the authoritative criterion outcome to `PASS`

#### Scenario: Judge decision updates authoritative outcome
- **WHEN** a valid judge decision covers a frozen criterion
- **THEN** the backend persists the attempt-scoped decision and updates the task criterion's current authoritative outcome

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

### Requirement: Durable integration state fails closed across restart
The system SHALL project integration attempts and candidate-bound re-review state from SQLite and SHALL NOT duplicate automatic recovery or infer acceptance after restart.

#### Scenario: Restart after resolved candidate creation
- **WHEN** the database reopens after a resolved candidate was persisted but before a valid candidate-bound re-review completed
- **THEN** durable context reports pending re-review and the resolved candidate cannot satisfy delivery

#### Scenario: Restart loses active Integrator process
- **WHEN** a nonterminal Integrator child cannot be truly resumed after restart
- **THEN** the backend records an interrupted terminal outcome, preserves the one-attempt bound, and returns the gap to the Supervisor

### Requirement: Runtime context is projected from durable state
The system SHALL build supervisor continuation context from durable goal, change, task, attempt, criterion, review, and delivery state plus bounded sanitized summaries; raw AI response history SHALL NOT be the authoritative source of current runtime state.

#### Scenario: Continuation after restart uses durable projection
- **WHEN** a continuation is built after reopening the database
- **THEN** it contains the same task statuses, attempt counts, criterion gaps, last judge decision, and delivery state recorded before restart

#### Scenario: Historical prose conflicts with current state
- **WHEN** an earlier AI response claims completion but durable criterion or delivery state remains incomplete
- **THEN** the context identifies the durable gaps and does not present the prose claim as current fact

### Requirement: Historical state backfill fails closed
The system SHALL preserve historical terminal goals and SHALL mark any unprovable criterion outcome for a migrated non-terminal goal as `UNKNOWN` rather than inferring success from plain summaries.

#### Scenario: Legacy success has no criterion decision
- **WHEN** a non-terminal historical delegation has a success summary but no authoritative criterion decision
- **THEN** migration preserves the summary and records the affected criterion outcomes as `UNKNOWN`
- **AND** completion remains blocked until authoritative decisions exist
