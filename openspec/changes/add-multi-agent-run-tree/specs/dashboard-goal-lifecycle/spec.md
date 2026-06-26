## ADDED Requirements

### Requirement: Dashboard shows multi-agent run tree
The dashboard SHALL display a goal-scoped multi-agent tree or grouped view when agent or task relationship metadata is present.

#### Scenario: Main agent has child agents
- **WHEN** the goal has observations linking child agents to a parent agent
- **THEN** the dashboard displays the parent-child relationship in a tree or grouped structure

#### Scenario: Node has current status
- **WHEN** a tree node has derived live status
- **THEN** the dashboard displays the node's state, role, provider/model when known, last activity, and safe summary

#### Scenario: Node is waiting or stalled
- **WHEN** a tree node status is waiting, stalled, failed, or blocked
- **THEN** the dashboard visually distinguishes that node so the user can identify where work is stuck

### Requirement: Dashboard links tree nodes to timeline context
The dashboard SHALL let users inspect events related to a tree node without losing the full durable goal timeline.

#### Scenario: User selects a tree node
- **WHEN** the user selects an agent or task node
- **THEN** the dashboard can show or highlight related timeline events for that node

#### Scenario: Tree metadata is incomplete
- **WHEN** some observations have missing or orphaned parent/task metadata
- **THEN** the dashboard renders fallback nodes or grouped events without failing the goal detail view
