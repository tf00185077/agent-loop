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
