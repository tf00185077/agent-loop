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
The system SHALL render the goal's durable task history into supervisor continuation and nudge prompts: each announced task's identifier, title, status, per-criterion outcome when known, and last result summary, so a continuation does not require the supervisor to re-derive prior decomposition.

#### Scenario: Continuation after a worker result includes history
- **WHEN** a supervisor continuation starts after a child outcome for a goal with an announced task list
- **THEN** the continuation prompt lists every announced task with its current status and shows which criteria of the affected task passed or failed

#### Scenario: History reflects rejections and splits
- **WHEN** a task has accumulated substantive rejections or was split into narrower tasks
- **THEN** the continuation prompt shows the rejection count, the cited failing criteria, and the lineage to the narrower tasks

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
The system SHALL complete a managed goal when the supervisor emits a valid completion control block containing a safe result summary.

#### Scenario: Supervisor signals completion
- **WHEN** supervisor output contains a valid `managed_delegation.complete` control block
- **THEN** the backend marks the run and goal completed and records the safe result summary in durable events

#### Scenario: Malformed completion block
- **WHEN** supervisor output contains an invalid completion control block
- **THEN** the backend records a rejection with a safe reason and the goal remains in its current state

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
