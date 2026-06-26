## ADDED Requirements

### Requirement: Multi-agent tree is derived from durable events
The system SHALL derive a goal-scoped multi-agent run tree from durable observation events and live status data.

#### Scenario: Single-agent run renders as one node
- **WHEN** a goal has only single-agent provider observations
- **THEN** the derived tree contains a root agent or run node representing that work
- **AND** no parent agent metadata is required

#### Scenario: Subagent relationship is present
- **WHEN** observations include agent id and parent agent id metadata
- **THEN** the derived tree places the child agent under the parent agent

#### Scenario: Delegated task relationship is present
- **WHEN** observations include task id metadata for delegated work
- **THEN** the derived tree includes a task node or task association for the related agent activity

### Requirement: Tree nodes expose current status
The system SHALL include live status information on each agent or task node when enough events are available.

#### Scenario: Child agent is running
- **WHEN** a child agent has non-terminal recent activity
- **THEN** its tree node shows a running state, last activity time, provider/model when known, and a safe summary

#### Scenario: Child agent fails
- **WHEN** a child agent receives a failure, cancellation, blocked, or timeout observation
- **THEN** its tree node shows the terminal state and sanitized failure summary

### Requirement: Orchestration lifecycle events are semantic
The system SHALL support semantic observations for main-agent/subagent orchestration lifecycle rather than requiring tree derivation from free-form messages.

#### Scenario: Agent is spawned
- **WHEN** an observation indicates a subagent was spawned
- **THEN** the tree builder creates or updates a child agent node with parent correlation metadata

#### Scenario: Task is assigned
- **WHEN** an observation indicates a task was assigned to an agent
- **THEN** the tree builder associates the task with the agent node

#### Scenario: Agent joins or returns result
- **WHEN** an observation indicates a child agent joined, completed, or returned a result
- **THEN** the tree builder updates the child node and parent relationship without requiring raw provider output

### Requirement: Tree derivation tolerates imperfect metadata
The system SHALL handle missing, duplicated, orphaned, and out-of-order relationship metadata safely.

#### Scenario: Child appears before parent
- **WHEN** a child agent observation is persisted before the parent observation
- **THEN** the tree builder reconciles the relationship once parent metadata appears

#### Scenario: Parent never appears
- **WHEN** an observation references a missing parent agent
- **THEN** the tree builder renders a safe orphan or fallback node instead of dropping the observation

#### Scenario: Duplicate observations appear
- **WHEN** duplicate relationship observations are present
- **THEN** the tree builder keeps a stable node identity and does not duplicate the same agent/task node
