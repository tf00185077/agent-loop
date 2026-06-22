## ADDED Requirements

### Requirement: Codex Local settings are tested after save
The system SHALL automatically run the Codex Local connection test after Codex Local provider settings are saved with a command path, using the saved model label or saved Codex CLI default selection that future goal runs will use.

#### Scenario: Saved Codex Local model is auto-tested
- **WHEN** a dashboard user saves Codex Local provider settings with a command path and a selected catalog model
- **THEN** the backend persists the settings
- **AND** the dashboard triggers the backend Codex Local connection test using the saved command path and model label
- **AND** the resulting provider status is persisted and shown to the user

#### Scenario: Saved Codex CLI default is auto-tested
- **WHEN** a dashboard user saves Codex Local provider settings with a command path and no concrete model label
- **THEN** the automatic connection test omits the Codex model argument
- **AND** the result reflects whether the Codex CLI default can answer

#### Scenario: Manual retry remains available
- **WHEN** an automatic Codex Local connection test fails or times out
- **THEN** the dashboard still allows the user to run the manual Test connection action
- **AND** the backend returns only sanitized status information

### Requirement: Run metadata is displayable from durable events
The system SHALL record provider and model metadata in durable run-level or provider-message event data when a runtime path knows that metadata, so the dashboard can distinguish mock, Codex Local, Claude Local, and future provider-backed runs without accessing provider credentials.

#### Scenario: Provider-backed run exposes display metadata
- **WHEN** a provider-backed runtime records `run.started`, `agent.message`, or `error` events with known provider/model metadata
- **THEN** the event data includes non-sensitive provider and model identifiers suitable for dashboard display

#### Scenario: Mock run exposes display metadata
- **WHEN** the mock runtime records run-level events
- **THEN** the event data includes non-sensitive mock provider/model identifiers suitable for dashboard display

#### Scenario: Metadata omits credentials
- **WHEN** provider/model metadata is returned through event APIs
- **THEN** it does not include command secret arguments, access tokens, auth cache contents, cookies, API keys, or authorization headers
