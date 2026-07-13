# managed-delegation-core Specification (Delta)

## ADDED Requirements

### Requirement: Children spawn through role-resolved adapters
The system SHALL spawn child sessions through the adapter resolved for the delegation's role rather than unconditionally inheriting the parent session's adapter, using the resolved provider and model for child capability detection, session records, and run rows.

#### Scenario: Worker child uses the resolved adapter
- **WHEN** a delegation dispatches with a role-resolved adapter differing from the parent's
- **THEN** the child session starts through the resolved adapter and its run row records the resolved provider and model

#### Scenario: Parent adapter remains the default
- **WHEN** no role resolution applies
- **THEN** the child spawns through the parent session's adapter with unchanged provider and model recording
