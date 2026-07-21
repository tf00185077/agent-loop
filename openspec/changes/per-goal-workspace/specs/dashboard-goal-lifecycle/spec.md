# dashboard-goal-lifecycle Delta

## MODIFIED Requirements

### Requirement: Dashboard creates goals
The system SHALL allow a local user to create a goal from the dashboard by submitting a title, description, priority, agent type, and an optional workspace directory. When a workspace is supplied the backend SHALL validate it (a non-empty absolute path to an existing directory) and reject an invalid one with a safe reason; when omitted the goal SHALL use the server's default workspace.

#### Scenario: Goal is created from dashboard
- **WHEN** the user submits a valid goal creation form
- **THEN** the backend persists the goal and the dashboard can show the new goal in the goal list

#### Scenario: Goal is created with a workspace
- **WHEN** the user submits a goal with a workspace that is an existing absolute directory
- **THEN** the backend persists the goal with that workspace and the goal detail view shows it

#### Scenario: Invalid workspace is rejected
- **WHEN** the user submits a goal whose workspace is not an existing absolute directory
- **THEN** the backend rejects the creation with a safe reason and no goal is persisted

## ADDED Requirements

### Requirement: Goal detail shows the resolved workspace
The system SHALL show, on the goal detail view, the workspace the goal runs in (the goal's workspace, or the server default when none was set).

#### Scenario: Detail shows the workspace
- **WHEN** the user opens a goal's detail view
- **THEN** the dashboard displays the goal's resolved workspace directory
