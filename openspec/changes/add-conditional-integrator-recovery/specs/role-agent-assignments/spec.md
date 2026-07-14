## MODIFIED Requirements

### Requirement: User-configured role assignments
The system SHALL let the user assign, per child role (`worker`, `spec_writer`, `review_merge`, `integrator`), a provider, model label, and optional command path in persisted provider settings; roles without an assignment SHALL inherit the goal's selected provider and model.

#### Scenario: Assigned role uses its configured agent
- **WHEN** a child delegation is dispatched while its role is assigned to a different provider/model than the goal's
- **THEN** the child session runs through an adapter for the assigned provider and the assigned model label

#### Scenario: Integrator assignment is backend resolved
- **WHEN** conditional recovery dispatches an Integrator and an `integrator` assignment exists
- **THEN** the backend uses the configured provider/model subject to the same capability-gated fallback as other child roles

#### Scenario: Unassigned roles inherit the goal provider
- **WHEN** a delegation is dispatched for a role with no assignment
- **THEN** the child runs through the parent session's adapter with the goal's provider and model, exactly as before
