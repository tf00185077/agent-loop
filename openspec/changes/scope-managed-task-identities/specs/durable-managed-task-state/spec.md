## ADDED Requirements

### Requirement: Managed task identity is goal scoped
The system SHALL assign every persisted managed task an opaque globally unique internal identifier and SHALL retain the supervisor-authored task identifier as a logical identifier unique only within its owning goal. All persisted task relations SHALL use the internal identifier, while supervisor prompts, control blocks, durable event metadata, and public task records SHALL use the logical identifier.

#### Scenario: Different goals reuse a logical task identifier
- **WHEN** two different goals each register a task with logical identifier `spec:plan-foundation`
- **THEN** both tasks are persisted with different internal identifiers
- **AND** each goal projects and mutates only its own task

#### Scenario: One goal repeats a logical task identifier
- **WHEN** one goal registers the same logical task identifier more than once
- **THEN** the existing immutable task contract remains authoritative and no duplicate task row is created

#### Scenario: Logical task lookup is scoped to the current goal
- **WHEN** a runtime operation references a logical task identifier
- **THEN** the backend resolves it using the current goal identifier
- **AND** a task with the same logical identifier in another goal cannot satisfy the lookup

### Requirement: Legacy managed task identities migrate without history loss
The system SHALL migrate legacy databases whose managed-task primary keys contain logical identifiers to opaque internal identifiers while preserving goal ownership, logical identifiers, parent lineage, criteria, attempts, reviews, integrations, deliveries, and authoritative outcomes. Migration SHALL be idempotent and SHALL leave no foreign-key violations.

#### Scenario: Legacy task graph is migrated
- **WHEN** the backend opens a legacy database containing a managed task with related durable records
- **THEN** each task receives one opaque internal identifier
- **AND** every related record references that identifier while exposing the original logical identifier

#### Scenario: Migrated database is reopened
- **WHEN** the backend reopens a database after identity migration completed
- **THEN** existing internal identifiers remain unchanged
- **AND** SQLite reports no managed-task foreign-key violations

#### Scenario: Continuation after migration
- **WHEN** a continuation is projected for a migrated goal
- **THEN** its task identifiers, statuses, criterion outcomes, attempt counts, reviews, and delivery state match the pre-migration logical history
