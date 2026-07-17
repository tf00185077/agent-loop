# multi-epoch-planning (delta)

## MODIFIED Requirements

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
