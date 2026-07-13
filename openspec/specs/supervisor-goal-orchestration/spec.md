# supervisor-goal-orchestration Specification

## Purpose

Define how a managed supervisor session turns one large user goal into an executed result: the bootstrap prompt contract, durable task decomposition, sequential per-task worker delegation, iterate-until-done continuation behavior, explicit completion signaling, and provider-neutral control-block extraction.

## Requirements

### Requirement: Supervisor bootstrap prompt contract
The system SHALL start a managed supervisor session with a generated bootstrap prompt that includes the goal title and description, the supervisor role framing, instructions to decompose the goal into an ordered task list before delegating, instructions to delegate exactly one worker task at a time, instructions to request a review-merge child after worker results that changed files, and the exact fenced control-block output format with the rule that only fenced control blocks are honored.

#### Scenario: Managed goal starts with the orchestration prompt
- **WHEN** a goal starts through the managed supervisor path
- **THEN** the supervisor session's initial prompt contains the goal context, decomposition instructions, the delegation control-block format, and the completion control-block format
- **AND** the placeholder single-sentence prompt is no longer used

#### Scenario: Continuation prompts re-carry the contract
- **WHEN** a supervisor continuation starts without true resume support
- **THEN** the continuation prompt contains the child result observation together with the same control-block contract sections as the bootstrap prompt

### Requirement: Durable task decomposition
The system SHALL record the supervisor's announced task decomposition as durable event data so the task list survives refresh and backend restart.

#### Scenario: Supervisor announces a task list
- **WHEN** supervisor output announces the ordered task list for the goal
- **THEN** the backend persists a durable event carrying the task list as safe metadata

#### Scenario: Delegations reference tasks
- **WHEN** a supervisor delegation control block includes a task identifier
- **THEN** the persisted delegation request records that task identifier and delegation lifecycle events carry it as safe metadata

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
