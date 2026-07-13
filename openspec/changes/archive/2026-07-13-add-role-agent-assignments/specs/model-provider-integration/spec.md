# model-provider-integration Specification (Delta)

## ADDED Requirements

### Requirement: Role assignments are persisted credential-free
The system SHALL persist role assignments with provider settings, sanitizing assignment command paths on save and read, and SHALL round-trip them through the provider-settings APIs with shape validation (known roles, known providers, string model labels).

#### Scenario: Assignments survive restart
- **WHEN** role assignments are saved and the backend restarts on the same database
- **THEN** the provider-settings API returns the same assignments

#### Scenario: Invalid assignment shapes are rejected
- **WHEN** a settings update names an unknown role or provider
- **THEN** the API rejects it with a validation error and existing settings are unchanged

#### Scenario: Assignment paths are sanitized
- **WHEN** an assignment command path contains credential-like arguments
- **THEN** persisted settings and API responses contain only the sanitized path

### Requirement: Dashboard role assignment controls
The dashboard provider setup SHALL provide per-role assignment controls: enable/inherit, provider selection, model label, and command path per child role.

#### Scenario: User assigns a role
- **WHEN** the user assigns the worker role to a provider with a model label and saves
- **THEN** the backend persists the assignment and subsequent goals dispatch workers accordingly

#### Scenario: User clears an assignment
- **WHEN** the user resets a role to inherit
- **THEN** the saved settings omit that role and dispatch reverts to the goal provider
