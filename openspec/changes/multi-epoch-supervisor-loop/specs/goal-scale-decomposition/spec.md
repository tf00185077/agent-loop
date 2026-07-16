# goal-scale-decomposition Delta Specification

## MODIFIED Requirements

### Requirement: Change plan control block
The system SHALL accept a `managed_change.plan` control block from a supervisor declaring an ordered list of changes with unique identifiers, titles, rationales, and optional acyclic dependencies, and SHALL enforce deterministic plan budgets (between 1 and 8 changes, existing dependency references, one plan per planning epoch, later epochs admitted only through an unsatisfied goal reassessment, change identifiers unique across all epochs of the goal) in backend validators.

#### Scenario: Valid plan is accepted
- **WHEN** a supervisor emits a valid change plan within budgets
- **THEN** the backend persists the plan durably with its epoch sequence, registers each change, and records the plan order

#### Scenario: Budget violations are rejected
- **WHEN** a plan exceeds the change-count budget, repeats identifiers (within the plan or across earlier epochs), or contains cyclic or unknown dependencies
- **THEN** the backend rejects the control block with a durable safe reason and the goal state is unchanged

#### Scenario: Plan without an admitted epoch is rejected
- **WHEN** a supervisor emits a change plan while the goal already has one and no unsatisfied reassessment is pending
- **THEN** the backend rejects the control block with a durable safe reason

#### Scenario: Small goals need no plan
- **WHEN** a supervisor proceeds with a flat task list and never emits a change plan
- **THEN** the goal executes under the existing single-tier flow with no change-level gating

### Requirement: Merged-evidence change completion
The system SHALL archive a planned change only when all of its registered tasks are done and, when its workers produced attested file changes, a successful review-merge outcome has applied them to the goal workspace; the backend SHALL reject a supervisor completion signal while planned changes remain unarchived across any epoch or while the latest goal reassessment is missing or unsatisfied.

#### Scenario: Unmerged worker output blocks archive
- **WHEN** a change's tasks are done but attested worker file changes were never merged
- **THEN** the change cannot archive and the backend records the missing-merge reason durably

#### Scenario: Completion requires all changes archived
- **WHEN** a supervisor emits a completion control block while a planned change is unarchived
- **THEN** the backend rejects it with a safe reason naming the remaining changes

#### Scenario: Completion requires a satisfied reassessment
- **WHEN** a supervisor emits a completion control block for a planned goal whose latest reassessment is missing or unsatisfied
- **THEN** the backend rejects it with a safe reason naming the reassessment gate

#### Scenario: Archive is recorded durably
- **WHEN** a change meets its completion conditions
- **THEN** the backend archives it (CLI or degraded move) and emits a durable archived event with the change identifier
