## MODIFIED Requirements

### Requirement: Backend provider contract
The system SHALL define a backend-only model provider contract that runtime code can call without depending on provider-specific HTTP or process details. The contract SHALL carry an opaque, provider-owned conversation-state value that the runtime passes through unchanged: a provider MAY return a conversation-state value in its output, and the runtime MAY supply a previously returned value on a later call so a provider can continue a session. The runtime MUST NOT interpret the conversation-state value.

#### Scenario: Runtime uses fake provider
- **WHEN** a runtime test injects a fake provider that returns response text
- **THEN** the runtime completes without importing or constructing a provider-specific adapter

#### Scenario: Runtime passes conversation state through unchanged
- **WHEN** a provider returns a conversation-state value and the runtime later calls the same provider with that value supplied as input
- **THEN** the runtime forwards the exact value to the provider without inspecting or modifying it

#### Scenario: Conversation state is optional
- **WHEN** a provider returns no conversation-state value
- **THEN** the runtime completes the call and does not require a conversation-state value on subsequent calls

## REMOVED Requirements

### Requirement: OpenAI local logged-in agent provider
**Reason**: The generic JSON-stdio wrapper indirection (`scripts/codex-local-agent-wrapper.mjs` driven by the provider-agnostic `openai-local-agent` adapter) is replaced by a Codex-specific provider that spawns the Codex CLI directly. The chosen direction is one provider per vendor CLI, so the universal wrapper protocol and its `AUTO_AGENT_OPENAI_LOCAL_*` / wrapper command-path env contract are removed.
**Migration**: Use the Codex direct-spawn provider (see ADDED "Codex direct-spawn provider" requirement). Saved Codex Local provider settings (command path, model label) are reused unchanged; no user-facing settings migration is required. Backends that set `AUTO_AGENT_OPENAI_LOCAL_COMMAND` / `AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON` must instead rely on the Codex Local provider settings and detected command path.

## ADDED Requirements

### Requirement: Codex direct-spawn provider
The system SHALL support a backend Codex provider that spawns the Codex CLI directly, without a generic wrapper process, using the user's locally authenticated Codex access. The provider SHALL own Codex-specific invocation details (running `codex exec`, selecting the model argument from the saved model label, and reading the Codex last-message output) behind the backend provider contract.

#### Scenario: Backend spawns Codex CLI directly
- **WHEN** the backend is configured for the Codex Local provider and a goal is started
- **THEN** the provider invokes the detected Codex command with `codex exec` and the goal prompt and records the Codex response through the provider contract
- **AND** no intermediate wrapper script process is spawned

#### Scenario: Model label selects the Codex model argument
- **WHEN** the saved model label is a concrete model and a goal is started
- **THEN** the provider passes that model to Codex as the model argument
- **AND** when the label is blank or a default/placeholder label, the provider omits the model argument and lets Codex choose its default

#### Scenario: Codex provider does not expose subscription secrets
- **WHEN** the Codex direct-spawn provider is used
- **THEN** dashboard API responses and durable event data do not include Codex authentication tokens, session material, or subscription credential material

#### Scenario: Missing Codex configuration fails visibly
- **WHEN** the backend is configured for the Codex Local provider without a usable command path
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

### Requirement: Saved Codex command path is self-healing
The system SHALL verify the saved Codex command path before using it and SHALL re-run Codex CLI detection when the saved path no longer resolves, persisting the newly detected path rather than spawning a stale path.

#### Scenario: Stale saved path is re-detected
- **WHEN** the saved Codex command path no longer exists or can no longer execute Codex and Codex CLI is detectable elsewhere
- **THEN** the backend re-detects the Codex command, updates the saved settings to the newly detected path, and uses the detected path for execution

#### Scenario: Valid saved path is used without re-detection
- **WHEN** the saved Codex command path still resolves and can execute Codex
- **THEN** the backend uses the saved path without overwriting it

#### Scenario: No path can be resolved fails visibly
- **WHEN** the saved Codex command path no longer resolves and no Codex CLI can be detected
- **THEN** starting a goal records an `error` event and the goal reaches failed status, and provider status reports a command-not-found condition without marking the app as connected
