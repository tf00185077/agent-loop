## MODIFIED Requirements

### Requirement: Continuations carry the durable task history
The system SHALL render the goal's SQLite-backed task history into supervisor continuation and nudge prompts: each task's identifier, title, status, attempt count, substantive rejection count, per-criterion authoritative outcome, last safe result summary, last judge decision, and delivery state, so a continuation does not require the supervisor to re-derive prior work from AI response history.

#### Scenario: Continuation after a worker result includes durable history
- **WHEN** a supervisor continuation starts after a child outcome for a goal with registered tasks
- **THEN** the continuation lists every task with its persisted current status and shows which criteria passed, failed, are blocked, or remain unknown

#### Scenario: History reflects review, delivery, and splits
- **WHEN** a task has a judge decision, pending or completed delivery, substantive rejections, or narrower descendants
- **THEN** the continuation shows the decision, delivery status, rejection count, cited criteria, and lineage from durable state

#### Scenario: Continuation is rebuilt after restart
- **WHEN** the backend builds a continuation after reopening SQLite
- **THEN** the rendered task history is equivalent to the last committed durable state before restart

### Requirement: Explicit supervisor completion signal
The system SHALL treat a valid `managed_delegation.complete` control block as a completion request and SHALL complete the managed goal only when the backend completion evaluator verifies the durable task, criterion, review, delivery, and change-plan gates.

#### Scenario: Completion request passes all gates
- **WHEN** supervisor output contains a valid completion block and every registered leaf task is accepted, every required criterion is `PASS`, no attempt/review/delivery is pending, no attested changes are undelivered, and all planned changes are archived when a plan exists
- **THEN** the backend atomically marks the run and goal completed and records the safe result summary in terminal events

#### Scenario: Completion request has durable gaps
- **WHEN** a valid completion block is emitted while any required task, criterion, review, delivery, or change-plan condition is incomplete
- **THEN** the backend rejects the request without completing the goal
- **AND** it records and returns a structured safe list of completion gaps in the next continuation

#### Scenario: Malformed completion block
- **WHEN** supervisor output contains an invalid completion block
- **THEN** the backend records a rejection with a safe reason and the goal remains in its current state

#### Scenario: Split task completion follows accepted descendants
- **WHEN** a parent task was split under the narrowing rule
- **THEN** the completion evaluator treats it as satisfied only when it has at least one narrower descendant and every required leaf descendant is accepted


