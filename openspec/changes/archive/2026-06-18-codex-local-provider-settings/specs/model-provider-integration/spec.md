## ADDED Requirements

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
