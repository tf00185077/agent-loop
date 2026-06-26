## ADDED Requirements

### Requirement: Providers emit structured observability progress
The backend provider contract SHALL allow providers to emit structured observability progress during execution without changing the final provider response contract.

#### Scenario: Provider emits structured progress
- **WHEN** a provider emits a structured observation before returning a final response
- **THEN** the provider runtime persists a durable observability event for the active goal
- **AND** the provider can still return its final response through the existing provider output path

#### Scenario: Provider emits no structured progress
- **WHEN** a provider does not support structured progress observations
- **THEN** the provider-backed run still records normal lifecycle and final result or error events
- **AND** the run does not fail solely because no observations were emitted

### Requirement: Codex Local maps JSONL events to observations
The Codex Local provider SHALL prefer a Codex execution mode that emits JSONL progress events when the installed Codex CLI supports it, and SHALL map recognized JSONL events into provider-agnostic observations.

#### Scenario: Codex command item starts
- **WHEN** Codex JSONL indicates a command execution item started
- **THEN** the provider emits a command-started observation with a safe command summary and Codex event provenance

#### Scenario: Codex command item completes
- **WHEN** Codex JSONL indicates a command execution item completed
- **THEN** the provider emits a command-completed observation with status and safe bounded output summary when available

#### Scenario: Codex emits an error event
- **WHEN** Codex JSONL emits an error or turn-failed event
- **THEN** the provider emits a failure observation and preserves the existing provider error handling behavior

#### Scenario: Codex emits unknown JSONL
- **WHEN** Codex JSONL contains an unknown event type
- **THEN** the provider ignores it or emits a generic sanitized progress observation without failing the run solely because the event is unknown

### Requirement: Codex final response behavior is preserved
The Codex Local provider SHALL preserve final response and error semantics while adding observability progress.

#### Scenario: Codex completes after progress
- **WHEN** Codex emits observability events and then produces a final answer
- **THEN** the provider returns the final answer through the provider output path
- **AND** the timeline contains progress observations before the final provider result event

#### Scenario: Codex JSONL final message is available
- **WHEN** Codex JSONL includes a final agent message suitable for the provider response
- **THEN** the provider MAY use that final message as the returned response text

#### Scenario: Codex JSONL is unavailable
- **WHEN** the installed Codex CLI does not support the selected JSONL execution mode
- **THEN** the provider falls back to the existing last-message execution path and records a sanitized observation that rich progress is unavailable

### Requirement: Provider timeout diagnostics include live context
The provider runtime SHALL record enough safe context on provider timeouts to help users decide the next debugging step.

#### Scenario: Provider times out after observations
- **WHEN** a provider process times out after emitting observations
- **THEN** the terminal error event includes safe timeout context such as timeout duration, provider, model, and command label
- **AND** previously persisted observations remain visible in the timeline

#### Scenario: Provider times out without observations
- **WHEN** a provider process times out without emitting observations
- **THEN** the terminal error event still includes safe timeout context
- **AND** the timeline indicates that no provider progress was observed before timeout

### Requirement: Provider observations are sanitized before persistence
The provider runtime SHALL sanitize structured observation messages and bounded output summaries before persisting or streaming them.

#### Scenario: Codex output includes credential-like material
- **WHEN** Codex stdout, stderr, JSONL fields, or command output includes credential-like material
- **THEN** the durable event contains redacted safe text
- **AND** dashboard API responses never expose the original credential-like material
