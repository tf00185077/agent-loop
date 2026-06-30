## ADDED Requirements

### Requirement: Codex provider exposes managed runtime capabilities
The model provider integration SHALL expose Codex runtime capabilities such as true resume, continuation fallback, managed home support, and JSONL event support.

#### Scenario: Runtime requests provider capabilities
- **WHEN** the runtime initializes the Codex provider
- **THEN** the provider reports whether true resume, managed `CODEX_HOME`, and structured JSONL parsing are enabled

### Requirement: Codex provider separates command failure classes
The model provider integration SHALL classify Codex execution failures into actionable categories.

#### Scenario: Codex command is missing
- **WHEN** the Codex executable cannot be found
- **THEN** the provider reports a missing-command diagnostic

#### Scenario: Codex exits with an auth error
- **WHEN** Codex output indicates missing or invalid authentication
- **THEN** the provider reports an auth diagnostic rather than a generic provider failure

#### Scenario: Codex exits with unknown failure
- **WHEN** Codex exits unsuccessfully without a recognized category
- **THEN** the provider reports command exit code, stderr summary, and preserved diagnostic output
