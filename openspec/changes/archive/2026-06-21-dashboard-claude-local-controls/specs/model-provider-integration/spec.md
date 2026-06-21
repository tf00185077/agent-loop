## MODIFIED Requirements

### Requirement: Dashboard provides provider setup controls
The system SHALL provide a dashboard provider setup experience for selecting, testing, and saving the local provider configuration, including selecting between the mock, Codex Local, and Claude Local providers.

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

#### Scenario: User selects Claude Local provider
- **WHEN** the dashboard user selects Claude Local in provider setup
- **THEN** the dashboard shows a free-text model label input, a command path input, a Detect control, and save controls
- **AND** the dashboard shows Claude-specific detection wording rather than Codex wording
- **AND** the dashboard does not show a model catalog picker or a connection test control for Claude Local

#### Scenario: Switching provider resets the model label
- **WHEN** the dashboard user switches the selected provider segment
- **THEN** the model label is reset so the previous provider's label does not carry across
- **AND** switching back to the currently-saved provider restores its saved model label
