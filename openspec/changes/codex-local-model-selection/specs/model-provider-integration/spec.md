## ADDED Requirements

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

## MODIFIED Requirements

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
