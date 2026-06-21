## Purpose

Define the backend-only model provider integration boundary for provider-backed runtime smoke execution, including OpenAI-compatible adapters, Codex direct-spawn execution, durable lifecycle events, failure handling, and dashboard credential isolation.

## Requirements

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

### Requirement: OpenAI-compatible adapter
The system SHALL support an OpenAI-compatible chat completions provider adapter configured from backend environment values.

#### Scenario: Adapter sends chat completions request
- **WHEN** the adapter is called with goal context and provider configuration
- **THEN** it sends a `POST` request to the configured `/chat/completions` endpoint with the configured model and backend authorization header

#### Scenario: Adapter extracts response text
- **WHEN** the configured endpoint returns a valid chat completions response with assistant content
- **THEN** the adapter returns the assistant text to the runtime

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

### Requirement: Provider-backed runtime completes a smoke step
The system SHALL support a provider-backed runtime path that calls the configured provider once and persists the result as durable lifecycle events.

#### Scenario: Provider-backed goal completes
- **WHEN** a draft goal is started while the backend is configured for a real provider path
- **THEN** the system creates a run, creates one provider-backed step, records an `agent.message` event containing provider response text, marks the step completed, marks the run completed, and marks the goal completed

#### Scenario: Timeline identifies provider metadata
- **WHEN** the provider-backed runtime records run or message events
- **THEN** the event data includes enough provider and model metadata to distinguish the provider-backed path from the mock path

### Requirement: Provider failures are durable
The system SHALL convert provider configuration errors, provider HTTP errors, and malformed provider responses into durable failed runtime state.

#### Scenario: Provider call fails
- **WHEN** the provider-backed runtime cannot obtain valid response text from the provider
- **THEN** it records an `error` event, marks the run failed, and marks the goal failed

#### Scenario: Missing provider configuration fails visibly
- **WHEN** the backend is configured for a real provider path without required provider configuration
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

### Requirement: Dashboard remains provider-agnostic
The system SHALL keep provider credentials and provider execution behind the backend boundary.

#### Scenario: Dashboard starts provider-backed run through existing API
- **WHEN** a dashboard user starts a goal
- **THEN** the dashboard still calls only the existing backend start endpoint and reads the resulting events through the existing event timeline endpoint

#### Scenario: Dashboard never receives provider secrets
- **WHEN** the backend is configured with provider credentials
- **THEN** dashboard API responses do not include API keys, authorization headers, or provider secret values

### Requirement: Provider settings are persisted locally
The system SHALL persist the selected local provider settings so a user can restart the app and start provider-backed goals without re-entering terminal environment variables.

#### Scenario: Default provider settings are mock
- **WHEN** no provider settings have been saved
- **THEN** the backend reports `mock` as the selected provider
- **AND** starting a goal uses the mock provider path

#### Scenario: Codex Local provider settings are saved
- **WHEN** the dashboard saves Codex Local provider settings with a model label and Codex command path
- **THEN** the backend persists those non-sensitive settings in local storage
- **AND** subsequent provider status requests return the selected provider and model label

#### Scenario: Provider settings survive restart
- **WHEN** Codex Local provider settings have been saved and the backend process restarts using the same SQLite database
- **THEN** the backend continues to report Codex Local as the selected provider

### Requirement: Codex CLI command can be detected and overridden
The system SHALL help the user resolve a Codex CLI command path for the Codex Local provider without hard-coding a single operating-system-specific path.

#### Scenario: Codex CLI is available on PATH
- **WHEN** the backend checks for Codex CLI and `codex` is available on the process PATH
- **THEN** the provider status reports Codex CLI as detected
- **AND** the detected command can be used for Codex Local connection testing

#### Scenario: Codex CLI requires manual path
- **WHEN** the backend cannot find Codex CLI automatically
- **THEN** the dashboard allows the user to enter a manual command path
- **AND** saving that path makes the backend use it for Codex Local connection testing and goal execution

#### Scenario: Invalid manual path fails clearly
- **WHEN** the saved Codex command path cannot be executed
- **THEN** the provider status or connection test reports a command-not-found failure without marking the app as connected

### Requirement: Codex Local connection can be tested from the dashboard
The system SHALL provide a dashboard-triggered connection test that verifies the configured Codex Local provider can run through the backend wrapper.

#### Scenario: Codex Local connection succeeds
- **WHEN** the user tests Codex Local provider settings and the wrapper obtains a valid Codex response
- **THEN** the backend records a connected status with a last-checked timestamp
- **AND** the dashboard shows that Codex Local is ready for provider-backed goals

#### Scenario: Codex authentication is unavailable
- **WHEN** the user tests Codex Local provider settings and Codex CLI indicates authentication is missing or unusable
- **THEN** the dashboard shows guidance to complete `codex login` using Codex-managed authentication
- **AND** the system does not request, store, or display OpenAI OAuth tokens

#### Scenario: Codex connection test fails
- **WHEN** the user tests Codex Local provider settings and the command exits unsuccessfully
- **THEN** the backend returns a sanitized failure status
- **AND** the dashboard shows actionable failure guidance without exposing credential material

### Requirement: Saved provider settings drive goal starts
The system SHALL use saved provider settings when starting a goal, so Codex Local provider-backed runs do not require shell environment setup each time.

#### Scenario: Start goal with saved Codex Local settings
- **WHEN** Codex Local provider settings are saved and a dashboard user starts a draft goal
- **THEN** the backend invokes the Codex Local wrapper using the saved Codex command path and model label
- **AND** the goal timeline records provider-backed runtime events through the existing start endpoint

#### Scenario: Saved mock settings keep mock behavior
- **WHEN** mock provider settings are saved and a dashboard user starts a draft goal
- **THEN** the backend uses the mock runtime path
- **AND** no Codex Local command is invoked

### Requirement: Provider setup remains credential-safe
The system SHALL keep Codex authentication and provider credential material outside dashboard-managed persisted settings and API responses.

#### Scenario: Provider settings omit credential material
- **WHEN** provider settings are saved
- **THEN** the persisted settings do not include OpenAI access tokens, Codex auth cache contents, browser cookies, API keys, authorization headers, or command secret arguments

#### Scenario: Provider APIs omit credential material
- **WHEN** the dashboard reads provider settings, provider status, or connection test results
- **THEN** the response does not include OpenAI access tokens, Codex auth cache contents, browser cookies, API keys, authorization headers, or command secret arguments

### Requirement: Dashboard provides provider setup controls
The system SHALL provide a dashboard provider setup experience for selecting, testing, and saving the local provider configuration.

#### Scenario: User selects Codex Local provider
- **WHEN** the dashboard user selects Codex Local in provider setup
- **THEN** the dashboard shows Codex CLI detection state, model catalog loading state, model selection controls, command path controls, connection test controls, and save controls

#### Scenario: User selects a catalog model
- **WHEN** Codex CLI model catalog discovery returns selectable models
- **THEN** the dashboard allows the user to choose a model from the catalog
- **AND** saving settings persists the chosen model slug as the Codex Local model label

#### Scenario: User chooses Codex CLI default
- **WHEN** the model catalog loaded and the user does not select a specific model
- **THEN** the dashboard saves a blank model label so Codex CLI uses its own default model

#### Scenario: Model catalog lookup fails
- **WHEN** model catalog discovery fails or returns malformed output
- **THEN** the dashboard shows the failure and the raw Codex CLI output
- **AND** the dashboard does not offer a model selection or default fallback until the catalog loads

#### Scenario: User selects mock provider
- **WHEN** the dashboard user selects mock provider in provider setup
- **THEN** the dashboard can save mock as the selected provider
- **AND** the dashboard does not require Codex CLI detection, model catalog lookup, or login checks before saving

### Requirement: Codex Local model catalog is discoverable
The system SHALL provide a backend-mediated way to discover selectable Codex Local model slugs from the configured local Codex CLI.

#### Scenario: Catalog returns selectable models
- **WHEN** Codex CLI model catalog discovery succeeds
- **THEN** the backend returns visible selectable models ordered by priority
- **AND** each model includes only safe display fields such as slug, display name, description, and priority

#### Scenario: Catalog omits unsafe raw metadata
- **WHEN** Codex CLI returns raw model catalog data
- **THEN** returned model catalog entries do not include base instructions, prompt metadata, hidden model entries, upgrade payloads, authentication material, cookies, or access tokens

#### Scenario: Catalog lookup surfaces failures
- **WHEN** Codex CLI model catalog discovery fails or returns malformed output
- **THEN** the backend returns an unavailable status whose detail includes the raw Codex CLI output or error
- **AND** provider setup surfaces the failure, including the raw output, and does not silently fall back to manual model entry or Codex CLI default behavior

### Requirement: Codex Local model selection uses safe defaults
The system SHALL avoid forcing stale or unsupported Codex Local model labels when a user has not selected a known working model.

#### Scenario: No model is selected
- **WHEN** Codex Local settings are saved without a selected model slug
- **THEN** provider-backed goal execution and connection testing do not pass a `--model` argument to Codex CLI
- **AND** Codex CLI uses its own default model

#### Scenario: Catalog model is selected
- **WHEN** Codex Local settings are saved with a selected catalog model slug
- **THEN** provider-backed goal execution and connection testing pass that slug as the Codex CLI model

#### Scenario: Legacy unsupported default is present
- **WHEN** existing saved settings contain the legacy `gpt-5-codex-subscription` model label
- **THEN** provider-backed goal execution and connection testing do not force that label as a Codex CLI model
- **AND** the dashboard allows the user to replace it with a catalog model or Codex CLI default


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
