## MODIFIED Requirements

### Requirement: User-configured role assignments
The system SHALL let the user assign, per child role (`worker`, `spec_writer`, `review_merge`, `integrator`), a provider and model in persisted provider settings; the model SHALL be chosen from a provider-appropriate list (the live Codex model catalog for `codex-local`; the stable Claude tier aliases for `claude-local`) rather than free text, and the role command path SHALL be auto-detected rather than user-entered. Roles without an assignment SHALL inherit the goal's selected provider and model.

#### Scenario: Assigned role uses its configured agent
- **WHEN** a child delegation is dispatched while its role is assigned to a different provider/model than the goal's
- **THEN** the child session runs through an adapter for the assigned provider and the assigned model label

#### Scenario: Integrator assignment is backend resolved
- **WHEN** conditional recovery dispatches an Integrator and an `integrator` assignment exists
- **THEN** the backend uses the configured provider/model subject to the same capability-gated fallback as other child roles

#### Scenario: Unassigned roles inherit the goal provider
- **WHEN** a delegation is dispatched for a role with no assignment
- **THEN** the child runs through the parent session's adapter with the goal's provider and model, exactly as before

#### Scenario: Role model is chosen from a provider-appropriate dropdown
- **WHEN** the user assigns a `codex-local` or `claude-local` provider to a role
- **THEN** the editor offers the role's model as a dropdown — the Codex catalog for `codex-local`, the stable Claude tier aliases for `claude-local` — and does not present a command-path input, which is auto-detected
