# task-acceptance-contracts Specification

## Purpose

Define the frozen per-task acceptance contract model: immutable criterion identifiers enforced by backend validators, cite-only review verdicts with deferred findings, structured machine results with backend-attested file evidence, and the two-rejection narrowing rule that bounds reviewer/coder ping-pong.
## Requirements
### Requirement: Frozen per-task acceptance criteria
The system SHALL represent task acceptance as a list of criteria with immutable identifiers, binary, testable text, and an optional executable check definition, frozen when the task is announced and persisted as first-class managed task state; later task lists and delegations for the same task SHALL use the frozen criteria and checks from SQLite rather than criteria restated by the supervisor or recovered from AI prose.

#### Scenario: Task list carries acceptance criteria
- **WHEN** a supervisor announces a task list whose entries include acceptance criteria
- **THEN** the backend persists each task, criterion, and check definition before accepting a worker delegation

#### Scenario: Restated criteria do not mutate the contract
- **WHEN** a later task list or worker delegation for a known task presents criteria or checks that differ from the frozen definitions
- **THEN** the backend uses the persisted criteria and checks, records that the mutation attempt was ignored, and proceeds only under the original contract

#### Scenario: Restart preserves frozen criteria
- **WHEN** the backend restarts after a task contract is frozen
- **THEN** the next delegation, review, check execution, and completion gate use the same persisted criterion ids, text, and checks

### Requirement: Worker delegations require an acceptance contract
The system SHALL reject a worker delegation request for a known task that has no acceptance criteria in the task registry, with a durable safe reason instructing the supervisor to announce criteria first.

#### Scenario: Delegation without criteria is rejected
- **WHEN** a supervisor delegates a known task whose registry entry has no acceptance criteria
- **THEN** the backend records `delegation.rejected` with a reason that names the missing acceptance contract

#### Scenario: Ad-hoc delegations are marked uncontracted
- **WHEN** a supervisor delegates work without any task identifier
- **THEN** the backend accepts it, records it durably as uncontracted, and still applies rejection-lineage bounding to it

### Requirement: Structured machine results
The system SHALL support structured child results carrying per-criterion evidence and executed tests through a `managed_task.result` control block, SHALL persist those results on the worker attempt, and SHALL treat them as claims requiring authoritative judge and backend validation rather than task acceptance.

#### Scenario: Child emits a structured result
- **WHEN** a child's output contains a valid `managed_task.result` control block with criterion evidence and test entries
- **THEN** the backend persists the result and attested file evidence on the worker attempt
- **AND** the task remains unaccepted until the required judge and delivery gates pass

#### Scenario: Child emits no structured result
- **WHEN** a child completes without a valid `managed_task.result` control block
- **THEN** the backend records the safe terminal summary and empty executor evidence
- **AND** no criterion becomes `PASS` solely because the child process completed successfully

### Requirement: Backend-attested file evidence
The system SHALL determine a worker's changed files by inspecting the worker worktree's version-control status at child terminal, SHALL persist the attested list as the authoritative `filesChanged`, and SHALL record a durable discrepancy note when a child-claimed list disagrees with attestation.

#### Scenario: Worker files are attested from the worktree
- **WHEN** a worker child reaches a terminal outcome in an isolated worktree
- **THEN** the backend records the worktree's dirty paths as the attested changed files, independent of the child's claims

#### Scenario: Claimed files disagree with attestation
- **WHEN** a child-declared file list differs from the attested worktree status
- **THEN** the backend persists both, marks the discrepancy durably, and treats the attested list as authoritative

### Requirement: Cite-only review verdicts
The system SHALL accept a substantive review verdict only through a validated structured judge decision that references the frozen task and covers known criterion identifiers; objections that cite no known criterion SHALL be recorded as deferred findings and SHALL NOT change criterion outcomes or task status.

#### Scenario: Cited structured rejection is substantive
- **WHEN** a judge decision rejects a task result and marks one or more frozen criteria `FAIL` or `BLOCKED`
- **THEN** the backend persists those outcomes, increments the task's substantive rejection count once for the reviewed attempt, and records the cited criteria

#### Scenario: Uncited objection becomes a deferred finding
- **WHEN** review output raises an objection outside a valid structured decision or cites no existing criterion identifier
- **THEN** the backend records it durably as a deferred finding and leaves criterion outcomes, rejection count, and task status unchanged

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

### Requirement: Contracted task acceptance requires authoritative criterion decisions
The system SHALL mark a contracted task accepted only when every required criterion has an authoritative `PASS` decision and any required backend delivery has succeeded; for checked criteria the executed check outcome SHALL be the authoritative decision and judge prose SHALL NOT override an executed result; worker success, supervisor prose, executor evidence, or an empty evidence result SHALL NOT independently accept a task.

#### Scenario: Some criteria remain unknown
- **WHEN** a worker attempt succeeds but one or more frozen criteria remain `UNKNOWN`
- **THEN** the task remains awaiting review or evidence and cannot satisfy goal completion

#### Scenario: All criteria pass without workspace changes
- **WHEN** the judge marks every required criterion `PASS` and the attempt has no attested workspace changes
- **THEN** the backend marks the task accepted without requiring a delivery commit

#### Scenario: All criteria pass with workspace changes
- **WHEN** the judge marks every required criterion `PASS` and the attempt has attested workspace changes
- **THEN** the task remains awaiting delivery until backend apply, validation, and commit succeed

#### Scenario: Executed FAIL blocks acceptance regardless of judge prose
- **WHEN** a checked criterion's execution failed and the judge nonetheless accepts the attempt
- **THEN** the backend overrides the judge durably and the task is not accepted

### Requirement: Uncontracted work cannot satisfy completion
The system SHALL continue to record compatible ad-hoc delegations as uncontracted, but an uncontracted result SHALL NOT count as an accepted managed task or satisfy the goal completion gate.

#### Scenario: Supervisor completes after ad-hoc work
- **WHEN** a supervisor requests goal completion after performing only uncontracted work
- **THEN** the backend rejects completion and instructs the supervisor to register contracted tasks representing the delivered work

