# task-acceptance-contracts (delta)

## MODIFIED Requirements

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
