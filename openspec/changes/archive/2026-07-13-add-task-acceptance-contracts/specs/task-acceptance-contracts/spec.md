# task-acceptance-contracts Specification (Delta)

## ADDED Requirements

### Requirement: Frozen per-task acceptance criteria
The system SHALL represent task acceptance as a list of criteria with immutable identifiers and binary, testable text, frozen when the task is announced; later delegations for the same task SHALL use the frozen criteria from the backend registry rather than criteria restated by the supervisor.

#### Scenario: Task list carries acceptance criteria
- **WHEN** a supervisor announces a task list whose entries include acceptance criteria
- **THEN** the backend persists each task's criteria with stable criterion identifiers as durable event metadata

#### Scenario: Restated criteria do not mutate the contract
- **WHEN** a later worker delegation for a known task presents acceptance criteria that differ from the frozen contract
- **THEN** the backend uses the frozen criteria, records that a mutation attempt was ignored, and proceeds with the original contract

### Requirement: Worker delegations require an acceptance contract
The system SHALL reject a worker delegation request for a known task that has no acceptance criteria in the task registry, with a durable safe reason instructing the supervisor to announce criteria first.

#### Scenario: Delegation without criteria is rejected
- **WHEN** a supervisor delegates a known task whose registry entry has no acceptance criteria
- **THEN** the backend records `delegation.rejected` with a reason that names the missing acceptance contract

#### Scenario: Ad-hoc delegations are marked uncontracted
- **WHEN** a supervisor delegates work without any task identifier
- **THEN** the backend accepts it, records it durably as uncontracted, and still applies rejection-lineage bounding to it

### Requirement: Structured machine results
The system SHALL support structured child results carrying per-criterion evidence and executed tests, reported through a `managed_task.result` control block in child output, and SHALL fall back to the plain safe summary when no structured result is emitted.

#### Scenario: Child emits a structured result
- **WHEN** a child's output contains a valid `managed_task.result` control block with criterion evidence and test entries
- **THEN** the backend persists the structured result on the delegation request and in durable event metadata

#### Scenario: Child emits no structured result
- **WHEN** a child completes without a `managed_task.result` control block
- **THEN** the backend records the terminal outcome with the existing safe summary and empty criterion evidence

### Requirement: Backend-attested file evidence
The system SHALL determine a worker's changed files by inspecting the worker worktree's version-control status at child terminal, SHALL persist the attested list as the authoritative `filesChanged`, and SHALL record a durable discrepancy note when a child-claimed list disagrees with attestation.

#### Scenario: Worker files are attested from the worktree
- **WHEN** a worker child reaches a terminal outcome in an isolated worktree
- **THEN** the backend records the worktree's dirty paths as the attested changed files, independent of the child's claims

#### Scenario: Claimed files disagree with attestation
- **WHEN** a child-declared file list differs from the attested worktree status
- **THEN** the backend persists both, marks the discrepancy durably, and treats the attested list as authoritative

### Requirement: Cite-only review verdicts
The system SHALL count a rejection of a task result as substantive only when it cites at least one existing criterion identifier of that task; verdict content citing no known criterion SHALL be recorded as deferred findings that do not change task status.

#### Scenario: Cited rejection is substantive
- **WHEN** a review verdict rejects a task result citing criterion identifiers from the frozen contract
- **THEN** the backend records a substantive rejection with the cited criteria and increments the task's rejection count

#### Scenario: Uncited objection becomes a deferred finding
- **WHEN** review output raises an objection that cites no existing criterion identifier
- **THEN** the backend records it durably as a deferred finding and the task's rejection count and status are unchanged

### Requirement: Two-rejection narrowing rule
The system SHALL refuse to start a third worker delegation for a task that has accumulated two substantive rejections with unchanged criterion scope, and SHALL instruct the supervisor to split the remaining failing criteria into strictly narrower tasks or mark the task failed and re-plan.

#### Scenario: Third identical-scope retry is refused
- **WHEN** a supervisor delegates a task again after two substantive rejections without narrowing its criteria
- **THEN** the backend records `delegation.rejected` with a reason naming the narrowing rule and the failing criteria

#### Scenario: Narrower split proceeds
- **WHEN** the supervisor announces new tasks covering strictly fewer criteria than the failed task and delegates one of them
- **THEN** the backend accepts the delegation and records the lineage from the failed parent task

#### Scenario: Rejection lineage is durable
- **WHEN** substantive rejections are recorded for a task
- **THEN** the rejection count, cited criteria, and lineage survive in durable events and delegation rows in timeline order
