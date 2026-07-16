## MODIFIED Requirements

### Requirement: Historical state backfill fails closed
The system SHALL preserve historical terminal Goal lifecycle state and SHALL reconstruct or repair managed-task state only through named, transactional schema migrations. Legacy backfill SHALL run exactly once only for a database that lacked the managed-task ledger before initialization. A migration SHALL preserve the first authoritative frozen criterion contract, SHALL NOT apply criteria from a later task-list event that recorded the task in `ignoredCriteriaMutations`, and SHALL mark any unprovable criterion outcome for a migrated non-terminal Goal as `UNKNOWN` rather than infer success from summaries or aggregate task status. Reopening a successfully migrated database SHALL be a no-op for that migration.

#### Scenario: True legacy database is backfilled once
- **WHEN** the backend opens a database that did not contain the managed-task ledger before schema initialization
- **THEN** it reconstructs provable task identities, contracts, attempts, and summaries in one migration transaction
- **AND** it records the migration as applied in the same transaction

#### Scenario: Migrated database is reopened
- **WHEN** the backend reopens a database whose managed-task backfill or repair migration is already recorded as applied
- **THEN** that migration performs no task, criterion, attempt, review, delivery, integration, Goal, run, session, or event mutation

#### Scenario: Ignored criterion mutation is not replayed
- **WHEN** a later task-list event restates an existing frozen contract and names the task in `ignoredCriteriaMutations`
- **THEN** backfill and repair exclude the restated criteria from the task's authoritative contract
- **AND** a restart preserves the original criterion identifiers and text

#### Scenario: Proven replay corruption is repaired
- **WHEN** an initialized ledger contains criteria that durable provenance proves came only from replay of an ignored mutation event
- **THEN** the repair removes those criteria and their derived authoritative criterion-result rows transactionally
- **AND** it preserves raw events, delegation records, result summaries, and review audit records
- **AND** it does not infer or change any remaining criterion outcome

#### Scenario: Ambiguous provenance remains fail closed
- **WHEN** the migration cannot prove which historical criterion contract was authoritative
- **THEN** it preserves the existing rows, records a bounded durable migration diagnostic, and leaves completion fail closed

#### Scenario: Legacy success has no criterion decision
- **WHEN** a non-terminal historical delegation has a success summary but no authoritative criterion decision
- **THEN** migration preserves the summary and records the affected criterion outcomes as `UNKNOWN`
- **AND** completion remains blocked until authoritative decisions exist

#### Scenario: Existing blocked Goal is not reactivated
- **WHEN** migration repairs conclusively corrupted subordinate ledger rows for a Goal already in terminal `blocked` state
- **THEN** it does not change the Goal status or terminal timestamps and does not start, resume, complete, or retry any run or session
- **AND** later Goal recovery requires an explicit authorized operation outside migration
