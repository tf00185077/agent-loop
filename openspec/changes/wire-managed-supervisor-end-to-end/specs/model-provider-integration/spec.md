# model-provider-integration Specification (Delta)

## MODIFIED Requirements

### Requirement: Interactive runtime providers use agent sessions
The system SHALL route interactive local coding-agent providers through the agent runtime control plane by default when a goal starts from saved provider settings, constructing the provider's runtime adapter in the backend rather than requiring adapter injection through application options. One-shot providers MAY continue to use the existing provider contract when they do not require session control, and the backend SHALL fall back to the one-shot path with a durable downgrade event when managed capability detection reports managed sessions as unsupported.

#### Scenario: Codex Local starts as a managed session
- **WHEN** a goal is started with saved Codex Local provider settings and no adapter is injected
- **THEN** the backend constructs the Codex runtime adapter from the saved settings and starts a managed agent session
- **AND** Codex-specific process details remain behind the adapter boundary

#### Scenario: Claude Local starts as a managed session
- **WHEN** a goal is started with saved Claude Local provider settings and the Claude runtime adapter reports managed support
- **THEN** the backend constructs the Claude runtime adapter from the saved settings and starts a managed agent session

#### Scenario: Managed capability is unavailable
- **WHEN** a goal is started with an interactive provider whose adapter capability detection reports managed sessions as unsupported
- **THEN** the backend records a durable downgrade event and runs the goal through the existing one-shot provider path

#### Scenario: One-shot provider path remains available
- **WHEN** a goal is started with a mock or OpenAI-compatible completion provider
- **THEN** the backend may use the existing one-shot provider contract without requiring approval or session-control APIs

#### Scenario: Injected adapters still take precedence
- **WHEN** application options inject a runtime adapter for a provider
- **THEN** the backend uses the injected adapter instead of constructing one, preserving test and override behavior

## ADDED Requirements

### Requirement: Claude managed runtime adapter
The system SHALL provide a Claude runtime adapter implementing the provider-agnostic runtime adapter contract, spawning the Claude CLI in non-interactive print mode per session turn, reporting capabilities that exclude true resume in v1, and supporting cancellation by process termination.

#### Scenario: Claude supervisor session runs
- **WHEN** a managed session starts through the Claude runtime adapter
- **THEN** the adapter spawns the Claude CLI with the session prompt and emits runtime events for progress and terminal outcome

#### Scenario: Claude continuation uses fresh mode
- **WHEN** a supervisor continuation starts on a Claude-backed session
- **THEN** the control plane uses the fresh-continuation path with a rebuilt contract prompt and records the fallback reason

#### Scenario: Claude adapter surfaces control blocks
- **WHEN** Claude output contains a fenced `auto-agent-control` block
- **THEN** the adapter attaches the parsed control payload as control metadata on the emitted runtime event and strips the block from progress text

#### Scenario: Claude adapter failure is durable
- **WHEN** the Claude CLI cannot start or exits with an unrecognized failure
- **THEN** the adapter emits a terminal failure event with sanitized diagnostics and the goal reaches a failed state visibly
