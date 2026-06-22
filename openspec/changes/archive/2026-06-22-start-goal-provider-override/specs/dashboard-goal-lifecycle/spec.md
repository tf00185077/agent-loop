## ADDED Requirements

### Requirement: Dashboard starts goals with current provider selection
The dashboard SHALL send the currently selected provider/model state when the user starts a draft goal, without requiring the user to save that selection first.

#### Scenario: User starts with unsaved Codex model selection
- **WHEN** the user selects Codex Local and a catalog model in provider setup but does not press Save
- **AND** the user starts a draft goal
- **THEN** the start request includes the selected Codex provider, model label, and command path for that run

#### Scenario: User starts with saved defaults only
- **WHEN** the dashboard has no current provider override state for a start action
- **THEN** starting a draft goal still works using saved provider settings

### Requirement: Save remains a persistent default action
The dashboard SHALL keep Save as the action that persists provider defaults, separate from the per-run start selection.

#### Scenario: User changes model and starts without saving
- **WHEN** the user changes the selected model and starts a goal without pressing Save
- **THEN** the run uses the selected model
- **AND** the persisted provider settings remain unchanged

### Requirement: Goal detail shows actual run provider metadata
The dashboard SHALL display provider/model metadata from the actual run events, not from the saved provider setup defaults.

#### Scenario: Run uses per-run override
- **WHEN** a goal was started with a provider override
- **THEN** the goal detail and timeline show the provider/model metadata recorded for that run
