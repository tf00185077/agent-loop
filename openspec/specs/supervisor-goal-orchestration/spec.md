# supervisor-goal-orchestration Specification

## Purpose

Define how a managed supervisor session turns one large user goal into an executed result: the bootstrap prompt contract, durable task decomposition, sequential per-task worker delegation, iterate-until-done continuation behavior, explicit completion signaling, and provider-neutral control-block extraction.
## Requirements
### Requirement: Supervisor bootstrap prompt contract
The system SHALL start a managed supervisor session with a generated bootstrap prompt that includes the goal title and description, the supervisor role framing, instructions to decompose the goal into an ordered task list with per-task acceptance criteria before delegating, instructions to delegate exactly one worker task at a time, instructions to request a review-merge child after worker results that changed files, the rule that criterion identifiers are frozen and rejections must cite them, and the exact fenced control-block output format with the rule that only fenced control blocks are honored.

#### Scenario: Managed goal starts with the orchestration prompt
- **WHEN** a goal starts through the managed supervisor path
- **THEN** the supervisor session's initial prompt contains the goal context, decomposition-with-acceptance instructions, the frozen-criteria and citation rules, the delegation control-block format, and the completion control-block format

#### Scenario: Continuation prompts re-carry the contract
- **WHEN** a supervisor continuation starts without true resume support
- **THEN** the continuation prompt contains the child result observation together with the same control-block contract sections as the bootstrap prompt

### Requirement: Durable task decomposition
The system SHALL record the supervisor's announced task decomposition as durable event data so the task list survives refresh and backend restart, and each announced task SHALL carry acceptance criteria with stable identifiers and binary, testable text.

#### Scenario: Supervisor announces a task list
- **WHEN** supervisor output announces the ordered task list for the goal
- **THEN** the backend persists a durable event carrying the task list, including each task's acceptance criteria, as safe metadata

#### Scenario: Delegations reference tasks
- **WHEN** a supervisor delegation control block includes a task identifier
- **THEN** the persisted delegation request records that task identifier and delegation lifecycle events carry it as safe metadata

#### Scenario: Task without criteria cannot be delegated
- **WHEN** a supervisor announces a task without acceptance criteria and then delegates it
- **THEN** the backend rejects the delegation with a durable reason naming the missing acceptance contract

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

### Requirement: Iterate until explicit completion
The system SHALL continue a managed supervisor across multiple delegation cycles until the supervisor emits an explicit completion signal or a terminal failure, cancellation, or configured bound is reached; provider process exit alone SHALL NOT complete the goal.

#### Scenario: Multi-task goal runs task by task
- **WHEN** a supervisor decomposes a goal into multiple tasks and delegates them sequentially
- **THEN** each worker result returns to the supervisor as an observation and the supervisor continues to the next delegation without user input

#### Scenario: Session exits without completion signal
- **WHEN** a supervisor session ends without a completion signal and without a pending delegation
- **THEN** the backend starts a supervisor continuation prompting the supervisor to continue or complete, and records a durable continuation event

#### Scenario: Continuation bound reached
- **WHEN** the number of completion-less supervisor continuations reaches the configured bound
- **THEN** the backend marks the goal blocked with a durable reason instead of continuing indefinitely

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

### Requirement: Control-block extraction from provider text
The system SHALL extract fenced control blocks from provider assistant text through a provider-neutral extraction step, strip them from user-visible progress messages, and pass surrounding text through normal sanitized progress handling.

#### Scenario: Message mixes prose and a control block
- **WHEN** an assistant message contains prose and one fenced control block
- **THEN** the control block is parsed and handled as a control event, the prose is persisted as sanitized progress, and no fenced block text appears in durable event messages

#### Scenario: Malformed control block is rejected visibly
- **WHEN** an assistant message contains a fenced control block with invalid JSON or an unsupported type
- **THEN** the backend records a durable rejection event with a safe reason and the supervisor's next continuation includes that reason

### Requirement: Scale assessment in the bootstrap contract
The supervisor bootstrap prompt SHALL document goal scale assessment: the change-plan control block format, sizing guidance for when to split a goal into multiple changes, and the rule that small goals proceed with a flat task list.

#### Scenario: Bootstrap documents the change plan
- **WHEN** a managed goal starts
- **THEN** the bootstrap prompt contains the `managed_change.plan` format with an example and sizing guidance for choosing between a flat task list and a change plan

### Requirement: Task decomposition references the active change
The system SHALL associate task lists and worker delegations announced under a change plan with the active change identifier, inheriting it when absent and rejecting explicit mismatches.

#### Scenario: Task list inherits the active change
- **WHEN** a supervisor announces a task list while a change is active without naming a change
- **THEN** the registered tasks carry the active change identifier in durable metadata

#### Scenario: Mismatched change reference is rejected
- **WHEN** a task list or worker delegation names a change other than the active one
- **THEN** the backend rejects it with a safe reason naming the active change

### Requirement: Continuations carry change-level history
The system SHALL render change-plan state into supervisor continuation and nudge prompts when a plan exists: each change's identifier, title, status, and the active change's task summary.

#### Scenario: Continuation shows plan progress
- **WHEN** a supervisor continuation starts for a goal with a change plan
- **THEN** the prompt lists every planned change with its status and identifies the active change alongside the existing task history

### Requirement: Background supervisor run failures are durable

The system SHALL treat the goal's background supervisor run as an observed
operation: any failure that would otherwise escape the background run
unhandled (an unhandled promise rejection or thrown error not already recorded
through the normal durable-event path) SHALL be recorded as a durable failure
event for the goal and SHALL transition the goal to a durable terminal failure
status, rather than being reported only through a console log.

This requirement is an outermost safety net. Failures that the runtime already
records durably through its normal event flow SHALL NOT be double-recorded, and
the goal status SHALL end in a terminal failure state exactly once.

#### Scenario: Background run rejects without a durable trace

- **WHEN** a goal's background supervisor run rejects with an error that was not
  already recorded through the normal durable-event path
- **THEN** the backend persists a durable failure event for the goal and
  transitions the goal to a terminal failure status

#### Scenario: Already-durable failure is not double-recorded

- **WHEN** a goal's background supervisor run ends after the runtime has already
  recorded the failure durably and set a terminal goal status
- **THEN** the outermost safety net adds no duplicate failure event and does not
  change the already-terminal goal status

### Requirement: Interrupted goals resume from a durable projection on startup

The system SHALL resume, on startup after reconciliation, each goal in the
durable `interrupted` status by starting a fresh managed supervisor session
driven by a continuation prompt projected from durable state, and SHALL flip the
goal back to `running`. Before building the prompt the system SHALL rehydrate the
goal's in-memory task and change registries from durable rows so the continuation
reflects the ledger; the durable projection remains the authoritative state. The
resumed session SHALL be started from a continuation phase, never a bootstrap
phase, so prior work is not re-decomposed. Resume SHALL be best-effort: a resume
that cannot start is recorded durably and leaves the goal visibly non-running,
and a goal that cannot make progress across resumes is bounded by the existing
continuation cap rather than resumed forever.

#### Scenario: Interrupted goal is resumed with a continuation prompt

- **WHEN** the backend starts and finds a goal in `interrupted` status with
  durable task history
- **THEN** it rehydrates the goal's task and change registries from durable rows,
  starts a fresh supervisor session whose prompt is a continuation carrying the
  durable projection, flips the goal to `running`, and records a durable resume
  event

#### Scenario: Non-interrupted goals are not resumed

- **WHEN** the backend starts and a goal is not in `interrupted` status
- **THEN** the backend does not resume that goal

#### Scenario: Crash-to-continue survives a restart end to end

- **WHEN** a goal that was `running` with in-flight work is reconciled to
  `interrupted` on restart and then resumed
- **THEN** the goal returns to `running` under a fresh supervisor session that
  continues from the durable ledger rather than restarting the goal from scratch

#### Scenario: Failed resume is durable and does not spin

- **WHEN** resuming an interrupted goal fails to start its session
- **THEN** the failure is recorded durably and the goal is left visibly
  non-running rather than silently retried without bound
