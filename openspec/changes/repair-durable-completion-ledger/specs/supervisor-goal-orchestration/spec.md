## MODIFIED Requirements

### Requirement: Explicit supervisor completion signal
The system SHALL treat a valid `managed_delegation.complete` control block as a completion request and SHALL complete the managed Goal only when a Goal-scoped backend completion evaluator verifies the durable task, criterion, active attempt, review, candidate delivery-obligation, integration, and change-plan gates. Historical candidates that never received authoritative Judge acceptance or that have been terminally superseded SHALL remain auditable but SHALL NOT create delivery gaps.

#### Scenario: Completion request passes all gates
- **WHEN** supervisor output contains a valid completion block, every registered leaf task is accepted, every required criterion is `PASS`, no Goal-owned attempt, review, delivery, or integration is pending, every current delivery obligation is committed, and all planned changes are archived when a plan exists
- **THEN** the backend atomically marks the run and Goal completed and records the safe result summary in terminal events

#### Scenario: Completion request has durable gaps
- **WHEN** a valid completion block is emitted while any required Goal-owned task, criterion, active attempt, review, delivery obligation, integration, or change-plan condition is incomplete
- **THEN** the backend rejects the request without completing the Goal
- **AND** it records and returns a structured safe list of completion gaps in the next continuation

#### Scenario: Rejected historical attempt does not block an accepted retry
- **WHEN** a task has an earlier Judge-rejected attempt with attested changes and a later accepted attempt whose required delivery is committed
- **THEN** the completion evaluator does not require delivery of the rejected attempt
- **AND** the accepted task can satisfy Goal completion

#### Scenario: Completion evaluation is isolated by Goal
- **WHEN** another Goal has the same logical task identifier with an active attempt or undelivered candidate
- **THEN** those rows do not appear in the current Goal's completion gaps and cannot affect its completion result

#### Scenario: Malformed completion block
- **WHEN** supervisor output contains an invalid completion block
- **THEN** the backend records a rejection with a safe reason and the Goal remains in its current state

#### Scenario: Split task completion follows accepted descendants
- **WHEN** a parent task was split under the narrowing rule
- **THEN** the completion evaluator treats it as satisfied only when it has at least one narrower descendant and every required leaf descendant is accepted

## ADDED Requirements

### Requirement: Completion continuation diagnostics distinguish request outcomes
The system SHALL distinguish a supervisor turn that emitted no completion signal from a valid completion request that the backend rejected for durable gaps. Bounded continuation accounting SHALL preserve the last structured gap set and SHALL describe exhaustion as failure to reach successful completion rather than absence of a signal when one or more valid completion requests were evaluated.

#### Scenario: Valid completion request is rejected
- **WHEN** the supervisor emits a valid completion request and durable gaps remain
- **THEN** the backend records that the request was evaluated and rejected with the structured gaps
- **AND** the next continuation receives those gaps

#### Scenario: Continuation bound follows rejected requests
- **WHEN** repeated valid completion requests and repair turns reach the configured continuation bound without satisfying durable gates
- **THEN** the Goal becomes blocked with a reason stating that successful completion was not reached
- **AND** the terminal diagnostic preserves the last safe structured gaps

#### Scenario: Turn emits no completion request
- **WHEN** a supervisor session ends without a completion request and without a pending delegation
- **THEN** the continuation diagnostic identifies a completion-less exit rather than a rejected completion request

### Requirement: Planned task lists do not mutate synthetic spec contracts
The supervisor contract SHALL state that accepting a change plan already registers backend-authored synthetic `spec:<changeId>` tasks with frozen structural acceptance criteria. Subsequent task-list announcements SHALL describe implementation tasks and SHALL NOT replace or extend those synthetic contracts.

#### Scenario: Planned supervisor receives task-list guidance
- **WHEN** the backend accepts a change plan and generates subsequent supervisor guidance
- **THEN** the guidance identifies synthetic spec tasks as already registered with backend-authored frozen criteria
- **AND** it instructs the supervisor not to re-announce them in implementation task lists

#### Scenario: Synthetic spec contract is restated despite guidance
- **WHEN** a later task list restates a synthetic spec task with different criteria
- **THEN** the backend records the mutation as ignored and continues to use only the original frozen contract across restart and completion evaluation
