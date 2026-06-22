## ADDED Requirements

### Requirement: Start goal accepts provider override
The backend SHALL accept an optional provider override in the start-goal request and use it for that run instead of saved provider settings.

#### Scenario: Start with Codex Local override
- **WHEN** a draft goal is started with a Codex Local override containing a model label and command path
- **THEN** the backend invokes the Codex Local provider using that override for the run
- **AND** the run metadata records the override provider and model actually used

#### Scenario: Start with mock override
- **WHEN** a draft goal is started with a mock provider override
- **THEN** the backend uses the mock runtime for that run even if saved provider settings point to another provider

#### Scenario: Start without override preserves existing behavior
- **WHEN** a draft goal is started without a provider override
- **THEN** the backend selects the runtime from saved provider settings as before

### Requirement: Provider override is not persisted as settings
The system SHALL NOT persist per-run provider overrides into provider settings unless the user explicitly saves provider settings.

#### Scenario: Override differs from saved settings
- **WHEN** a goal is started with a provider override whose model differs from saved provider settings
- **THEN** the run uses the override model
- **AND** a later provider settings read still returns the saved model

### Requirement: Provider override is credential-safe
The backend SHALL sanitize and validate provider override fields before constructing a runtime.

#### Scenario: Override command path contains secret-like arguments
- **WHEN** a start request includes a command path with credential-like arguments
- **THEN** the backend removes or redacts unsafe secret-like arguments before using or recording the override
- **AND** dashboard responses and durable events do not expose credential material
