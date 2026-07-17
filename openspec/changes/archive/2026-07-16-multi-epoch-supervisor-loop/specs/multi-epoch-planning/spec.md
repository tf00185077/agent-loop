# multi-epoch-planning Delta Specification

## ADDED Requirements

### Requirement: Planning epochs
The system SHALL treat each accepted `managed_change.plan` control block as opening one planning epoch for the goal, recorded durably with a monotonically increasing sequence number, the batch's changes, and — for epochs after the first — the rationale from the reassessment that admitted it.

#### Scenario: First plan opens epoch one
- **WHEN** a supervisor's first valid change plan is accepted for a goal
- **THEN** the backend records a durable change-plan event carrying epoch sequence 1 and registers the batch's changes

#### Scenario: Later plan opens the next epoch
- **WHEN** a valid change plan is accepted after an unsatisfied reassessment
- **THEN** the backend records a durable change-plan event carrying the next epoch sequence and the reassessment's next-epoch rationale, registers the new changes, and activates the first of them

### Requirement: Goal reassessment control block
The system SHALL accept a `managed_goal.reassessment` control block from a supervisor of a planned goal, validated deterministically: `goalSatisfied` boolean, at least one non-empty evidence string, and — when unsatisfied — at least one non-empty remaining gap plus a non-empty next-epoch rationale; a satisfied judgment SHALL carry no remaining gaps. Accepted judgments SHALL be persisted as durable events.

#### Scenario: Valid unsatisfied judgment is recorded
- **WHEN** a supervisor emits an unsatisfied reassessment with evidence, remaining gaps, and a next-epoch rationale after all changes archived
- **THEN** the backend persists a durable reassessment event and arms the next-epoch gate

#### Scenario: Malformed judgment is rejected
- **WHEN** a reassessment omits evidence, or is unsatisfied without remaining gaps or rationale, or is satisfied while listing remaining gaps
- **THEN** the backend rejects the control block with a durable safe reason and goal state is unchanged

#### Scenario: Flat goals reject reassessment
- **WHEN** a supervisor of a goal with no change plan emits a reassessment
- **THEN** the backend rejects it with a safe reason and the flat completion flow is unchanged

### Requirement: Reassessment timing gate
The system SHALL reject a reassessment while any registered change of the goal is unarchived, after first attempting to archive an archivable active change.

#### Scenario: Premature reassessment is rejected
- **WHEN** a reassessment arrives while changes remain unarchived
- **THEN** the backend rejects it naming the unarchived changes

### Requirement: Satisfied claims are cross-checked against durable evidence
The system SHALL reject a `goalSatisfied=true` reassessment when the durable completion evaluator still reports gaps, citing those gaps in the safe reason.

#### Scenario: Durable gaps override a satisfied claim
- **WHEN** a supervisor claims the goal is satisfied while durable completion gaps exist
- **THEN** the backend rejects the reassessment listing the durable gaps

### Requirement: Next-epoch admission gate
The system SHALL accept a change plan for a goal that already has one only when the latest recorded reassessment is unsatisfied and no epoch has been opened since it, and SHALL require all change identifiers to be unique across every epoch of the goal.

#### Scenario: Plan without an armed gate is rejected
- **WHEN** a change plan arrives while no unsatisfied reassessment is pending
- **THEN** the backend rejects it with a durable safe reason

#### Scenario: Duplicate change id across epochs is rejected
- **WHEN** a next-epoch plan reuses a change id from an earlier epoch
- **THEN** the backend rejects the plan naming the colliding id

#### Scenario: Consuming the gate closes it
- **WHEN** a next-epoch plan is accepted
- **THEN** a further change plan is rejected until another unsatisfied reassessment is recorded

### Requirement: Completion binds to the latest reassessment
The system SHALL reject a completion signal for a planned goal unless the latest recorded reassessment is satisfied and no next-epoch gate is armed, in addition to the existing archived-changes and durable-completion checks.

#### Scenario: Completion without any reassessment is rejected
- **WHEN** a supervisor emits completion for a planned goal with all changes archived but no recorded reassessment
- **THEN** the backend rejects it naming the reassessment as the required next step

#### Scenario: Completion after an unsatisfied reassessment is rejected
- **WHEN** the latest reassessment found remaining gaps
- **THEN** the backend rejects completion until a next epoch runs and a satisfied reassessment is recorded

#### Scenario: Completion after a satisfied reassessment succeeds
- **WHEN** the latest reassessment is satisfied and durable completion evidence holds
- **THEN** the goal completes

### Requirement: Bounded macro loop
The system SHALL enforce a per-goal planning-epoch budget (configurable, default 5) and a repeated-gap circuit breaker: an unsatisfied reassessment whose normalized remaining-gap signature equals the previous reassessment's, or one that would exceed the epoch budget, SHALL move the goal to `blocked` with a durable reason instead of opening another epoch.

#### Scenario: Epoch budget exhaustion blocks the goal
- **WHEN** an unsatisfied reassessment arrives and the goal already has the maximum number of epochs
- **THEN** the goal transitions to blocked with a durable budget-exhausted reason

#### Scenario: Repeated identical gaps block the goal
- **WHEN** two consecutive reassessments report the same normalized remaining-gap signature
- **THEN** the goal transitions to blocked with a durable repeated-gap reason

### Requirement: Epoch state survives restart
The system SHALL rehydrate epoch sequences, change batches, change statuses, and reassessment history from durable events in chronological order after a backend restart, without re-registering existing work.

#### Scenario: Restart during a later epoch
- **WHEN** the backend restarts while a goal is executing its second epoch
- **THEN** the resumed supervisor is gated against the same epoch, changes, and reassessment history that existed before the restart

### Requirement: Epoch observability
The system SHALL expose planning epochs through the durable events API and the agent-session snapshot as a projection carrying, per epoch: sequence, rationale, derived status, member changes with statuses, and the epoch's reassessment result; the dashboard goal detail SHALL render the epoch board.

#### Scenario: Snapshot carries the epoch projection
- **WHEN** a client fetches the agent-session snapshot of a planned goal
- **THEN** the response includes `planningEpochs` derived from durable events

#### Scenario: Dashboard shows rounds and reasons
- **WHEN** a user opens the goal detail of a multi-epoch goal
- **THEN** the epoch board shows each epoch's changes with statuses and the recorded reassessment conclusions, including why a next epoch was created
