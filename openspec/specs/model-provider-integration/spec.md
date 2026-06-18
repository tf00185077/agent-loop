## Purpose

Define the backend-only model provider integration boundary for provider-backed runtime smoke execution, including OpenAI-compatible adapters, local logged-in agent execution, durable lifecycle events, failure handling, and dashboard credential isolation.

## Requirements

### Requirement: Backend provider contract
The system SHALL define a backend-only model provider contract that runtime code can call without depending on provider-specific HTTP details.

#### Scenario: Runtime uses fake provider
- **WHEN** a runtime test injects a fake provider that returns response text
- **THEN** the runtime completes without importing or constructing an OpenAI-compatible HTTP adapter

### Requirement: OpenAI-compatible adapter
The system SHALL support an OpenAI-compatible chat completions provider adapter configured from backend environment values.

#### Scenario: Adapter sends chat completions request
- **WHEN** the adapter is called with goal context and provider configuration
- **THEN** it sends a `POST` request to the configured `/chat/completions` endpoint with the configured model and backend authorization header

#### Scenario: Adapter extracts response text
- **WHEN** the configured endpoint returns a valid chat completions response with assistant content
- **THEN** the adapter returns the assistant text to the runtime

### Requirement: OpenAI local logged-in agent provider
The system SHALL support a backend-spawned local agent provider that can use a local command already authenticated with the user's OpenAI subscription-backed agent access.

#### Scenario: Backend spawns local logged-in agent
- **WHEN** the backend is configured for the openai-local-agent provider path
- **THEN** starting a goal invokes the configured local command with the goal prompt and records the command response through the provider contract

#### Scenario: Local agent does not expose subscription secrets
- **WHEN** the openai-local-agent provider is used
- **THEN** dashboard API responses and durable event data do not include browser cookies, session tokens, local command secrets, or subscription credential material

#### Scenario: Missing local agent configuration fails visibly
- **WHEN** the backend is configured for the openai-local-agent provider path without the required local command configuration
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

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
- **THEN** the dashboard shows Codex CLI detection state, model label controls, connection test controls, and save controls

#### Scenario: User selects mock provider
- **WHEN** the dashboard user selects mock provider in provider setup
- **THEN** the dashboard can save mock as the selected provider
- **AND** the dashboard does not require Codex CLI detection or login checks before saving
