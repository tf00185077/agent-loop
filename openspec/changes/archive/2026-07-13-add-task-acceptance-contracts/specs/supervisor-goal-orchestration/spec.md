# supervisor-goal-orchestration Specification (Delta)

## MODIFIED Requirements

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

### Requirement: Supervisor bootstrap prompt contract
The system SHALL start a managed supervisor session with a generated bootstrap prompt that includes the goal title and description, the supervisor role framing, instructions to decompose the goal into an ordered task list with per-task acceptance criteria before delegating, instructions to delegate exactly one worker task at a time, instructions to request a review-merge child after worker results that changed files, the rule that criterion identifiers are frozen and rejections must cite them, and the exact fenced control-block output format with the rule that only fenced control blocks are honored.

#### Scenario: Managed goal starts with the orchestration prompt
- **WHEN** a goal starts through the managed supervisor path
- **THEN** the supervisor session's initial prompt contains the goal context, decomposition-with-acceptance instructions, the frozen-criteria and citation rules, the delegation control-block format, and the completion control-block format

#### Scenario: Continuation prompts re-carry the contract
- **WHEN** a supervisor continuation starts without true resume support
- **THEN** the continuation prompt contains the child result observation together with the same control-block contract sections as the bootstrap prompt

## ADDED Requirements

### Requirement: Continuations carry the durable task history
The system SHALL render the goal's durable task history into supervisor continuation and nudge prompts: each announced task's identifier, title, status, per-criterion outcome when known, and last result summary, so a continuation does not require the supervisor to re-derive prior decomposition.

#### Scenario: Continuation after a worker result includes history
- **WHEN** a supervisor continuation starts after a child outcome for a goal with an announced task list
- **THEN** the continuation prompt lists every announced task with its current status and shows which criteria of the affected task passed or failed

#### Scenario: History reflects rejections and splits
- **WHEN** a task has accumulated substantive rejections or was split into narrower tasks
- **THEN** the continuation prompt shows the rejection count, the cited failing criteria, and the lineage to the narrower tasks
