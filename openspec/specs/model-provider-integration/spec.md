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
