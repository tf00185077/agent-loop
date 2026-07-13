# role-agent-assignments Specification

## Purpose

Define user-configured role→agent assignments for child delegations: the configuration shape, backend-only resolution order, capability-gated fallback with durable downgrade evidence, and resolved-provider recording so the timeline shows which agent executed each role.

## Requirements

### Requirement: User-configured role assignments
The system SHALL let the user assign, per child role (`worker`, `spec_writer`, `review_merge`), a provider, model label, and optional command path in persisted provider settings; roles without an assignment SHALL inherit the goal's selected provider and model.

#### Scenario: Assigned role uses its configured agent
- **WHEN** a worker delegation is dispatched while `worker` is assigned to a different provider/model than the goal's
- **THEN** the child session runs through an adapter for the assigned provider and the assigned model label

#### Scenario: Unassigned roles inherit the goal provider
- **WHEN** a delegation is dispatched for a role with no assignment
- **THEN** the child runs through the parent session's adapter with the goal's provider and model, exactly as before

### Requirement: Backend-only assignment resolution
The system SHALL resolve role assignments in the backend at dispatch time; delegation control blocks SHALL NOT select providers, and provider fields in supervisor output SHALL have no effect on resolution.

#### Scenario: Supervisor output cannot choose providers
- **WHEN** a delegation control block includes provider or model fields
- **THEN** resolution uses only the persisted role assignments and goal settings

#### Scenario: Injected adapters take precedence
- **WHEN** an adapter is injected for the assigned provider through application options
- **THEN** the resolver uses the injected adapter instead of constructing one

### Requirement: Capability-gated assignment fallback
The system SHALL verify an assigned adapter's managed capabilities before dispatch and, when unsupported or unresolvable, record a durable downgrade event naming the role, assigned provider, and safe reason, then dispatch with the goal's default adapter.

#### Scenario: Unsupported assignment degrades visibly
- **WHEN** the assigned provider's CLI is missing or reports managed execution unsupported
- **THEN** the backend records `role_assignment.downgraded` and the child runs on the goal's default adapter

#### Scenario: Goals never fail because of an assignment
- **WHEN** assignment resolution fails for any reason
- **THEN** the delegation proceeds on the goal's default adapter and only the downgrade event marks the difference

### Requirement: Resolved agent evidence
The system SHALL record the resolved provider and model on each child run and in delegation lifecycle event metadata, so the timeline shows which agent executed each role.

#### Scenario: Timeline shows the executing agent
- **WHEN** a child spawned through a role assignment reaches any lifecycle event
- **THEN** the durable run row and event metadata carry the resolved provider and model, not the parent's
