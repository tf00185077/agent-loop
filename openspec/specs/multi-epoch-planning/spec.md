# multi-epoch-planning Specification

## Purpose

Define the macro planning loop for planned goals: each accepted change plan
opens a durable planning epoch, every archived batch forces a goal-level
reassessment against the original goal, unsatisfied reassessments admit the
next epoch's change batch, completion binds to the latest satisfied
reassessment, and the loop is bounded, restart-recoverable, and observable.
## Requirements
### Requirement: Planning epochs
The system SHALL treat each accepted `managed_change.plan` control block as opening one planning epoch for the goal, recorded durably with a monotonically increasing sequence number, the batch's changes, and — for epochs after the first — the rationale from the reassessment that admitted it.

#### Scenario: First plan opens epoch one
- **WHEN** a supervisor's first valid change plan is accepted for a goal
- **THEN** the backend records a durable change-plan event carrying epoch sequence 1 and registers the batch's changes

#### Scenario: Later plan opens the next epoch
- **WHEN** a valid change plan is accepted after an unsatisfied reassessment
- **THEN** the backend records a durable change-plan event carrying the next epoch sequence and the reassessment's next-epoch rationale, registers the new changes, and activates the first of them

### Requirement: Goal reassessment control block
The system SHALL accept a `managed_goal.reassessment` control block from a supervisor of a planned goal, validated deterministically: `goalSatisfied` boolean, at least one non-empty evidence string, and — when unsatisfied — at least one structured remaining gap plus a non-empty next-epoch rationale; a satisfied judgment SHALL carry no remaining gaps. Each remaining gap SHALL be an object with a non-empty `summary` string and a non-empty `refs` array whose entries each resolve exactly to a durable artifact of this goal (a change id from any epoch, a registered task id, or an existing capability name under `openspec/specs/`) or declare new scope as `new:<kebab-case>`. Unknown refs, plain-string gaps, and empty ref arrays SHALL be rejected with a durable safe reason that teaches the structured form and lists the valid ref kinds. Accepted judgments SHALL be persisted as durable events including the structured gaps.

#### Scenario: Valid unsatisfied judgment is recorded
- **WHEN** a supervisor emits an unsatisfied reassessment with evidence, structured gaps whose refs resolve, and a next-epoch rationale after all changes archived or blocked
- **THEN** the backend persists a durable reassessment event carrying the structured gaps and arms the next-epoch gate

#### Scenario: Malformed judgment is rejected
- **WHEN** a reassessment omits evidence, or is unsatisfied without structured gaps or rationale, or is satisfied while listing remaining gaps
- **THEN** the backend rejects the control block with a durable safe reason and goal state is unchanged

#### Scenario: Unresolvable gap refs are rejected
- **WHEN** an unsatisfied reassessment carries a gap whose ref matches no change id, task id, or capability and is not a `new:` declaration
- **THEN** the backend rejects the control block naming the unresolvable ref and the valid ref kinds

#### Scenario: Flat goals reject reassessment
- **WHEN** a supervisor of a goal with no change plan emits a reassessment
- **THEN** the backend rejects it with a safe reason and the flat completion flow is unchanged

### Requirement: Reassessment timing gate
The system SHALL reject a reassessment while any registered change of the goal is neither archived nor blocked, after first attempting to archive an archivable active change. An unsatisfied reassessment for a goal with blocked changes SHALL be rejected unless every blocked change is referenced by at least one structured gap.

#### Scenario: Premature reassessment is rejected
- **WHEN** a reassessment arrives while changes remain neither archived nor blocked
- **THEN** the backend rejects it naming those changes

#### Scenario: Blocked scope must appear in the gaps
- **WHEN** an unsatisfied reassessment arrives for a goal with a blocked change that no gap references
- **THEN** the backend rejects it naming the unreferenced blocked change

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
The system SHALL enforce a per-goal planning-epoch budget (configurable, default 5) and a repeated-gap circuit breaker keyed on structured gap identity: the signature of an unsatisfied reassessment SHALL be the sorted, deduplicated union of its gaps' refs, prose summaries SHALL never participate, and an unsatisfied reassessment whose signature equals the previous unsatisfied reassessment's, or one that would exceed the epoch budget, SHALL move the goal to `blocked` with a durable reason instead of opening another epoch.

#### Scenario: Epoch budget exhaustion blocks the goal
- **WHEN** an unsatisfied reassessment arrives and the goal already has the maximum number of epochs
- **THEN** the goal transitions to blocked with a durable budget-exhausted reason

#### Scenario: Repeated gap refs block the goal regardless of wording
- **WHEN** two consecutive unsatisfied reassessments carry the same ref-set with differently worded summaries
- **THEN** the goal transitions to blocked with a durable repeated-gap reason naming the refs

#### Scenario: Distinct refs open the next epoch
- **WHEN** consecutive unsatisfied reassessments carry different ref-sets within the epoch budget
- **THEN** the next epoch is admitted under the existing admission gate

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

