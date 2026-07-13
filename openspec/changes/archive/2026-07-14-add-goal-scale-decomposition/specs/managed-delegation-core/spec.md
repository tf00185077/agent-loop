# managed-delegation-core Specification (Delta)

## ADDED Requirements

### Requirement: Delegations carry their change identifier
The system SHALL persist an optional change identifier on delegation requests and carry it in delegation lifecycle event metadata, so per-change execution state is reconstructable from durable records.

#### Scenario: Delegation records its change
- **WHEN** a worker delegation is dispatched while a change plan is active
- **THEN** the persisted delegation request and its lifecycle events carry the active change identifier

#### Scenario: Plan-less goals are unaffected
- **WHEN** a goal has no change plan
- **THEN** delegation requests persist without a change identifier exactly as before

### Requirement: One active change per goal
The system SHALL enforce at most one active change per goal at the delegation control plane, as the plan-level sibling of the one-active-child rule.

#### Scenario: Work outside the active change is rejected
- **WHEN** a delegation control event targets a planned change that is not currently active
- **THEN** the backend rejects it durably and execution of the active change is unaffected
