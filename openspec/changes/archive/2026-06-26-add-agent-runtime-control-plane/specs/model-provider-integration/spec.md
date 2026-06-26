## ADDED Requirements

### Requirement: Interactive runtime providers use agent sessions
The system SHALL route interactive local coding-agent providers through the agent runtime control plane instead of treating them only as one-shot text completion providers. One-shot providers MAY continue to use the existing provider contract when they do not require session control.

#### Scenario: Codex Local starts as a managed session
- **WHEN** a goal is started with Codex Local in interactive runtime mode
- **THEN** the backend starts a managed agent session through the Codex runtime adapter
- **AND** Codex-specific process details remain behind the adapter boundary

#### Scenario: One-shot provider path remains available
- **WHEN** a goal is started with a mock or OpenAI-compatible completion provider
- **THEN** the backend may use the existing one-shot provider contract without requiring approval or session-control APIs

### Requirement: Runtime provider capabilities are detected
The system SHALL detect and report provider-specific runtime capabilities before relying on interactive control features. Capabilities SHALL include event streaming, approval support, cancellation support, resume support, and child-session request support when known.

#### Scenario: Codex lacks approval support
- **WHEN** the configured Codex CLI mode cannot support backend-mediated approval resolution
- **THEN** the backend reports approval as unsupported for that session or provider status
- **AND** it does not present pending approvals as actionable if the adapter cannot resume after resolution

#### Scenario: Runtime capabilities omit secrets
- **WHEN** runtime capabilities are returned through provider status, session APIs, or durable events
- **THEN** they do not expose provider authentication material, command secret arguments, cookies, access tokens, API keys, or authorization headers

### Requirement: Interactive provider failures are control-plane failures
The system SHALL convert interactive runtime startup, capability, command-control, and adapter-loss failures into durable session and goal events rather than only provider completion errors.

#### Scenario: Runtime adapter cannot start
- **WHEN** an interactive runtime adapter cannot start the local agent process
- **THEN** the backend records a failed session state, persists a sanitized error event, and fails or blocks the goal run according to runtime policy

#### Scenario: Adapter loses control of a process
- **WHEN** the backend can no longer control an active local agent process
- **THEN** the backend records a visible stalled, failed, or cancelled session state instead of waiting only for the original provider timeout
