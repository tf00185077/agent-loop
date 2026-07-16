## ADDED Requirements

### Requirement: Supervisor task identifiers resolve within the current goal
The system SHALL treat task identifiers emitted by supervisors as goal-local logical identifiers. The backend SHALL resolve each task-list, delegation, result, review, recovery, and completion reference within the current goal before reading or mutating durable task state, and SHALL never expose the task's internal database identifier to the provider.

#### Scenario: Supervisor delegates a same-named task
- **WHEN** the current goal and another goal both contain `task-1` and the current supervisor delegates `task-1`
- **THEN** the delegation is associated only with the current goal's task

#### Scenario: Current goal does not own the logical identifier
- **WHEN** a supervisor references a logical task identifier that exists only in another goal
- **THEN** the backend rejects the reference as uncontracted or unknown for the current goal
- **AND** it does not read or mutate the other goal's task

#### Scenario: Durable context hides internal identity
- **WHEN** the backend builds continuation context or persists task lifecycle event metadata
- **THEN** it uses the goal-local logical task identifier
- **AND** the opaque internal task identifier is absent from provider-visible text and public event data
