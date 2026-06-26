## ADDED Requirements

### Requirement: Production Codex interactive starts use managed sessions
The system SHALL route production Codex Local starts through the managed Codex runtime adapter when Codex Local is selected for interactive runtime execution. The legacy one-shot provider path MAY remain available only for providers or settings explicitly configured for one-shot completion behavior.

#### Scenario: Saved Codex Local starts as managed session
- **WHEN** Codex Local provider settings are saved and the user starts a goal in interactive runtime mode
- **THEN** the backend starts a managed Codex session through the runtime adapter
- **AND** the resulting timeline does not create a provider smoke step for that interactive run

#### Scenario: Per-run Codex override starts as managed session
- **WHEN** a start-goal request includes a Codex Local provider override in interactive runtime mode
- **THEN** the backend starts a managed Codex session using the override command path and model label
- **AND** Codex-specific process details remain behind the backend runtime adapter

### Requirement: Codex resume limitations are explicit
The system SHALL report Codex runtime approval, authority, and resume limitations through sanitized runtime capability metadata before exposing actionable authority controls.

#### Scenario: Codex cannot resume authority grant
- **WHEN** the configured Codex runtime mode cannot resume the same session after authority approval
- **THEN** the backend reports resume as unsupported and uses restart-as-continuation when authority approval is granted

#### Scenario: Codex managed adapter cannot start
- **WHEN** the Codex runtime adapter cannot start or cannot verify required managed-session support
- **THEN** the backend records a failed or unsupported managed session state with sanitized diagnostics instead of silently falling back to a provider smoke step
