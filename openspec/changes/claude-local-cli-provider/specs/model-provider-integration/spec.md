## ADDED Requirements

### Requirement: Reusable CLI command detection
The system SHALL provide a reusable CLI command detection mechanism, parameterized by candidate command names, a capability probe, and common install locations, so that each subscription-backed local CLI provider is configured rather than reimplemented. Codex detection SHALL be expressed as a configuration of this mechanism without changing its existing behavior.

#### Scenario: Detection prefers a command on PATH
- **WHEN** a configured CLI's command name is available on the process PATH and passes the configured capability probe
- **THEN** detection reports the command as detected with its resolved path

#### Scenario: Detection falls back to common install locations
- **WHEN** the configured command is not on PATH but exists at one of the configured common install locations and passes the capability probe
- **THEN** detection reports that location as the detected command path

#### Scenario: Codex detection behavior is preserved
- **WHEN** Codex detection runs through the reusable mechanism with its Codex configuration
- **THEN** it resolves the same command path it resolved before generalization, using the `codex exec --help` capability probe

### Requirement: Reusable self-healing command path resolution
The system SHALL provide reusable command-path resolution that validates a saved path for any CLI provider and re-detects when the saved path no longer resolves, persisting the newly detected path rather than using a stale one.

#### Scenario: Stale saved path is re-detected for any CLI provider
- **WHEN** a CLI provider's saved command path no longer resolves and its command is detectable elsewhere
- **THEN** resolution re-detects the command, reports the new path as changed, and offers it for persistence

#### Scenario: Valid saved path is reused
- **WHEN** a CLI provider's saved command path still resolves and passes its capability probe
- **THEN** resolution returns the saved path without marking it changed

### Requirement: Claude Code direct-spawn provider
The system SHALL support a backend Claude provider that spawns the Claude Code CLI directly, without a wrapper process, using the user's locally authenticated Claude subscription. The provider SHALL own Claude-specific invocation details (running `claude --print` in non-interactive mode, selecting the model argument from the saved model label, and reading the whole response from stdout) behind the backend provider contract.

#### Scenario: Backend spawns Claude CLI directly
- **WHEN** the backend is configured for the Claude Local provider and a goal is started
- **THEN** the provider invokes the detected Claude command in non-interactive print mode with the goal prompt and records the Claude response through the provider contract
- **AND** no intermediate wrapper script process is spawned

#### Scenario: Model label selects the Claude model argument
- **WHEN** the saved model label is a concrete model and a goal is started
- **THEN** the provider passes that model to Claude as the model argument
- **AND** when the label is blank, the provider omits the model argument and lets Claude choose its default

#### Scenario: Claude provider returns no conversation state yet
- **WHEN** the Claude provider completes a goal
- **THEN** it returns the response text and an undefined conversation-state value, deferring session continuation

#### Scenario: Claude provider does not expose subscription secrets
- **WHEN** the Claude direct-spawn provider is used
- **THEN** dashboard API responses and durable event data do not include Claude authentication tokens, session material, or subscription credential material

#### Scenario: Missing Claude configuration fails visibly
- **WHEN** the backend is configured for the Claude Local provider without a usable command path
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

### Requirement: Claude Local provider settings are persisted locally
The system SHALL persist the selected Claude Local provider settings so a user can restart the app and start Claude-backed goals without re-entering terminal configuration.

#### Scenario: Claude Local provider settings are saved
- **WHEN** the dashboard saves Claude Local provider settings with a model label and Claude command path
- **THEN** the backend persists those non-sensitive settings in local storage
- **AND** subsequent provider status requests return Claude Local as the selected provider and its model label

#### Scenario: Claude Local provider settings survive restart
- **WHEN** Claude Local provider settings have been saved and the backend process restarts using the same SQLite database
- **THEN** the backend continues to report Claude Local as the selected provider

#### Scenario: Claude CLI command can be detected and overridden
- **WHEN** the backend detects the Claude CLI and `claude` is available on PATH or a common install location such as `~/.local/bin`
- **THEN** the provider status reports Claude CLI as detected and the detected command is used for Claude Local goal execution
- **AND** when Claude CLI cannot be found automatically, the user may save a manual command path that the backend uses instead
