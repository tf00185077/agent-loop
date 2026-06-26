## ADDED Requirements

### Requirement: Agent observations are durable timeline events
The system SHALL represent meaningful agent liveness, command execution, provider progress, and subtask activity as durable goal events before publishing them to live dashboard streams.

#### Scenario: Observation is persisted before streaming
- **WHEN** a running provider emits a structured observation for a goal
- **THEN** the backend persists a durable event for that goal
- **AND** the live event stream publishes the persisted event shape with an event id and timestamp

#### Scenario: Snapshot includes prior observations
- **WHEN** the dashboard reloads or reconnects after observations were emitted
- **THEN** the durable event snapshot includes the previously persisted observations in timeline order

### Requirement: Agent observation metadata identifies execution context
The system SHALL include non-sensitive execution metadata on agent observability events so current single-agent runs and future main-agent/subagent runs can be distinguished.

#### Scenario: Provider observation includes agent context
- **WHEN** a provider observation is persisted
- **THEN** its event data includes provider and model when known
- **AND** it MAY include agent role, agent id, parent agent id, task id, source, and raw provider event type

#### Scenario: Missing future orchestration metadata is tolerated
- **WHEN** a current single-agent provider emits an observation without parent agent or task metadata
- **THEN** the backend persists the observation without requiring future subagent fields

### Requirement: Command execution observations are semantic
The system SHALL represent provider-observed command execution with semantic durable events rather than requiring users to infer command state from raw output text.

#### Scenario: Command starts
- **WHEN** provider output indicates a command execution started
- **THEN** the system records a command-started observation with a safe command label or summary

#### Scenario: Command completes
- **WHEN** provider output indicates a command execution completed
- **THEN** the system records a command-completed observation with status and safe bounded output summary when available

#### Scenario: Command fails
- **WHEN** provider output indicates a command execution failed
- **THEN** the system records a command-failed observation with a safe failure summary

### Requirement: Agent liveness can be observed during long runs
The system SHALL provide bounded liveness observations for long-running provider executions so users can tell a run is still active before the final answer is available.

#### Scenario: Provider emits progress without final response
- **WHEN** a provider emits observations while final response generation is still in progress
- **THEN** the dashboard timeline can receive and display those observations before the run reaches a terminal state

#### Scenario: Provider is quiet
- **WHEN** a provider emits no structured activity for a configured interval while its process is still running
- **THEN** the backend MAY persist a throttled heartbeat observation indicating the provider process is still active

### Requirement: Observability output is credential-safe
The system SHALL sanitize provider process output and provider event payloads before storing or streaming observability events.

#### Scenario: Observation includes secret-like material
- **WHEN** provider stdout, stderr, JSONL, or command output contains tokens, cookies, API keys, authorization headers, auth cache material, or command secret arguments
- **THEN** the durable event and streamed event contain only redacted safe text

#### Scenario: Raw provider payloads are not stored by default
- **WHEN** a provider emits a raw JSONL event or process output chunk
- **THEN** the system stores only allowlisted metadata and bounded sanitized summaries by default

### Requirement: Subtask observations support future orchestration
The system SHALL support durable observations for delegated subtask lifecycle without requiring the main-agent/subagent scheduler to be implemented in this change.

#### Scenario: Subtask starts
- **WHEN** an agent observation indicates delegated work has started
- **THEN** the system can persist a subtask-started event with agent id, parent agent id, and task id when provided

#### Scenario: Subtask completes or fails
- **WHEN** an agent observation indicates delegated work completed or failed
- **THEN** the system can persist a subtask-completed or subtask-failed event with the same correlation metadata when provided
