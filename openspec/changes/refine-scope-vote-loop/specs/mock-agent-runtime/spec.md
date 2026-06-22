## ADDED Requirements

### Requirement: Runtime implements direct tasks without quorum review
The system SHALL execute planner decisions that are ready for direct implementation without running a quorum vote after implementation.

#### Scenario: Direct implementation completes assigned task
- **WHEN** the planner chooses direct implementation for the current task
- **THEN** the runtime marks the assigned step completed and closes the current work item without recording a scope vote event

### Requirement: Runtime supports explicit scope assessment
The system SHALL represent planner scope assessments separately from implementation completion review.

#### Scenario: Planner reports task is too large
- **WHEN** the planner determines the current task is too large to implement directly
- **THEN** the runtime records the scope assessment and counts it toward the current assessment attempt limit

#### Scenario: Planner reports task is too small
- **WHEN** the planner determines the current task is too small
- **THEN** the runtime treats the task as implementable and proceeds to direct implementation

### Requirement: Runtime runs binary scope votes after repeated broad assessments
The system SHALL run a three-voter binary scope vote when planner scope assessment attempts exceed the configured limit for a too-large task.

#### Scenario: Voters agree task still needs refinement
- **WHEN** the planner has reached the configured scope assessment attempt limit and a majority of scope voters return true
- **THEN** the runtime starts the next scope refinement round and includes the previous planner and voter reasons in the next planner context

#### Scenario: Voters reject further refinement
- **WHEN** the planner has reached the configured scope assessment attempt limit and a majority of scope voters return false
- **THEN** the runtime accepts the current scope and proceeds directly to implementation without asking the planner to reassess scope

### Requirement: Runtime bounds scope refinement rounds
The system SHALL use a configured scope refinement round limit that is separate from the planner assessment attempt limit.

#### Scenario: Refinement rounds are exhausted
- **WHEN** the runtime cannot produce an implementable task after the configured scope refinement round limit
- **THEN** the runtime marks the goal blocked and records a blocked event that indicates scope refinement was exhausted

### Requirement: Runtime blocks only from planner block or exhausted refinement
The system SHALL NOT derive blocked state from scope voter ballots.

#### Scenario: Planner blocks directly
- **WHEN** the planner returns a blocked decision
- **THEN** the runtime marks the goal blocked and records the planner reason

#### Scenario: Scope voters return false
- **WHEN** the scope vote majority returns false
- **THEN** the runtime proceeds to direct implementation instead of blocking
