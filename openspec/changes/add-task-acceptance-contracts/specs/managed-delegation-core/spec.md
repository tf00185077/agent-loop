# managed-delegation-core Specification (Delta)

## ADDED Requirements

### Requirement: Delegation requests persist their acceptance contract
The system SHALL persist the frozen acceptance criteria in force for a worker delegation on the delegation request itself, so the contract a child was dispatched under is reconstructable without replaying supervisor output.

#### Scenario: Contract is stored at dispatch
- **WHEN** the backend accepts a worker delegation for a task with acceptance criteria
- **THEN** the persisted delegation request includes the frozen criteria snapshot in force at dispatch

#### Scenario: Contract survives restart
- **WHEN** the backend reloads after a contracted delegation was dispatched
- **THEN** the delegation request still exposes the criteria snapshot alongside role, status, and result fields

### Requirement: Delegation results carry structured evidence
The system SHALL extend delegation result summaries with optional structured fields for per-criterion evidence, executed tests, child-claimed changed files, and backend-attested changed files, without breaking consumers of the existing safe summary.

#### Scenario: Structured result is persisted
- **WHEN** a child terminal outcome includes structured evidence
- **THEN** the delegation request's result records criterion evidence, tests, claimed files, and attested files alongside the safe summary

#### Scenario: Legacy summary-only results remain valid
- **WHEN** a child terminal outcome carries only a safe summary
- **THEN** the delegation result persists as before with structured fields absent

### Requirement: Durable rejection lineage per task
The system SHALL persist, per task, the count of substantive rejections, the criterion identifiers cited by each rejection, and the lineage between a task and any narrower tasks it was split into.

#### Scenario: Substantive rejection is recorded on the lineage
- **WHEN** a task result receives a substantive rejection citing criterion identifiers
- **THEN** durable events record the incremented rejection count and the cited criteria for that task

#### Scenario: Split lineage is recorded
- **WHEN** a task past the narrowing threshold is split into narrower tasks
- **THEN** durable events record the parent task identifier on each narrower task
