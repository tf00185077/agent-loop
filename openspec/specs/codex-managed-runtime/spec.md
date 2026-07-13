# codex-managed-runtime Specification

## Purpose

Define the Codex managed runtime adapter behavior for session identity capture, continuation resume, and structured JSONL observation handling.

## Requirements
### Requirement: Codex managed runtime captures session identity
The Codex managed runtime SHALL capture session identity and minimum invocation parameters from Codex JSONL output when a session starts.

#### Scenario: Session start event is parsed
- **WHEN** Codex emits a session or thread start JSONL event containing a session id
- **THEN** the runtime stores the session id with cwd, known model/options, and provider capability metadata

### Requirement: Codex managed runtime resumes when available
The Codex managed runtime SHALL use true Codex resume for continuations when a verified prior session id is available.

#### Scenario: Resume succeeds
- **WHEN** a continuation starts with a known session id and resume is enabled
- **THEN** the runtime invokes Codex resume mode and records that the continuation used true resume

#### Scenario: Resume is unavailable
- **WHEN** Codex resume fails because the session is unknown or resume is unsupported
- **THEN** the runtime starts a fresh continuation prompt and records the fallback reason

### Requirement: Codex JSONL parser emits MVP runtime observations
The Codex JSONL parser SHALL translate MVP-critical JSONL events into typed provider observations and preserve unknown or malformed lines for diagnostics.

#### Scenario: Assistant output is parsed
- **WHEN** Codex emits an assistant message JSONL event
- **THEN** the parser emits a provider assistant-message observation with the message content

#### Scenario: Error output is parsed
- **WHEN** Codex emits a structured error JSONL event
- **THEN** the parser emits a provider error observation with sanitized diagnostic content

#### Scenario: Malformed line is received
- **WHEN** Codex writes a non-JSON or unrecognized JSONL line
- **THEN** the parser stores it as diagnostic output without crashing the run

### Requirement: Codex adapter surfaces delegation control metadata
The Codex managed runtime adapter SHALL detect fenced control blocks in Codex assistant-message output and attach the parsed control payload as delegation or completion control metadata on the emitted runtime event, instead of emitting the block as plain progress text.

#### Scenario: Assistant message contains a delegation request block
- **WHEN** a Codex `agent_message` item contains a fenced `auto-agent-control` block with type `managed_delegation.request`
- **THEN** the adapter emits a runtime event whose metadata carries the parsed delegation control event
- **AND** the fenced block text does not appear in the event's progress message

#### Scenario: Assistant message contains a completion block
- **WHEN** a Codex `agent_message` item contains a fenced control block with type `managed_delegation.complete`
- **THEN** the adapter emits a runtime event whose metadata carries the parsed completion control event

#### Scenario: Assistant message contains no control block
- **WHEN** a Codex `agent_message` item contains only prose
- **THEN** the adapter emits the same progress observation it emitted before this change

### Requirement: Codex adapter is constructible from saved provider settings
The system SHALL construct the Codex managed runtime adapter from the saved Codex Local provider settings (resolved command path, model label) at goal start, without requiring adapter injection through application options.

#### Scenario: Goal starts with saved Codex Local settings
- **WHEN** a goal starts while Codex Local settings are saved and no adapter is injected
- **THEN** the backend builds the Codex runtime adapter from the resolved command path and model label and starts a managed session

#### Scenario: Managed mode is unavailable
- **WHEN** Codex adapter capability detection reports that managed session execution is unsupported by the installed CLI
- **THEN** the backend records a durable downgrade event and runs the goal through the existing one-shot provider path instead of failing silently
