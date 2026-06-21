## ADDED Requirements

### Requirement: Bounded plan-implement-observe loop
The system SHALL advance a goal through a bounded iterative loop that, each iteration, plans the next step, optionally implements it, observes the result, and persists durable progress, until the goal is judged complete or a termination bound is reached.

#### Scenario: Loop advances a goal across multiple steps
- **WHEN** a goal is started under the iterative loop runtime
- **THEN** the runtime creates a run and records more than one durable step before reaching a terminal goal state
- **AND** each step records its planner decision and, when implemented, its result

#### Scenario: Loop terminates at the step bound
- **WHEN** the loop reaches its configured `maxSteps` without the completion gate judging the goal done
- **THEN** the runtime stops the loop, records a terminal state, and does not continue planning further steps

#### Scenario: Single-call provider behavior is not used for loop goals
- **WHEN** a goal runs under the iterative loop runtime
- **THEN** completion is determined by the loop and its gate, not by a single provider call marking the goal complete

### Requirement: Planner emits a graduated decision
The system SHALL have a planner role that, each iteration, reads the run's persisted step history as context and emits exactly one decision from the closed set {`IMPLEMENT_DIRECTLY`, `DECOMPOSE`, `NEEDS_OPENSPEC`, `BLOCKED`} together with the next step and a reason. The planner SHALL NOT use a provider session; prior context comes from persisted steps.

#### Scenario: Planner chooses to implement a small step
- **WHEN** the planner judges the next step small enough to do directly
- **THEN** it emits `IMPLEMENT_DIRECTLY` with the step description and reason
- **AND** the loop runs the implementer on that step

#### Scenario: Planner decomposes a large step
- **WHEN** the planner judges the next step too large
- **THEN** it emits `DECOMPOSE` with sub-steps
- **AND** the loop enqueues the sub-steps and continues without implementing the original step

#### Scenario: Planner blocks on missing human input
- **WHEN** the planner cannot proceed without a human decision
- **THEN** it emits `BLOCKED` with a reason
- **AND** the loop records a blocked terminal state rather than continuing

#### Scenario: Planner reads prior steps as memory
- **WHEN** the planner runs on any iteration after the first
- **THEN** its input includes the prior persisted steps of the same run
- **AND** the runtime does not require a provider session to supply that context

### Requirement: Implementer produces a text result
The system SHALL have an implementer role that, for an `IMPLEMENT_DIRECTLY` step, produces a result describing what was done. For this capability the implementer SHALL NOT modify files or run commands.

#### Scenario: Implementer returns a result for a direct step
- **WHEN** the loop runs the implementer on an `IMPLEMENT_DIRECTLY` step
- **THEN** it records a result describing what was done
- **AND** no file is created, modified, or executed as part of the step

### Requirement: Completion gate decided by decorrelated quorum vote
The system SHALL decide the binary completion proposition ("does the current result satisfy the acceptance criteria?") by a majority vote of three voters, preferring three different providers for decorrelation. A voter that errors or times out SHALL abstain, and abstention SHALL be treated as "not done" (the safe side). Only the completion gate votes; generation steps SHALL NOT be decided by vote.

#### Scenario: Majority of voters judge the goal done
- **WHEN** at least two of three voters judge the proposition satisfied
- **THEN** the gate decides the goal is done and the loop reaches a completed terminal state

#### Scenario: Majority judge not done
- **WHEN** fewer than two voters judge the proposition satisfied
- **THEN** the gate decides not done and the loop continues (subject to the bounds)

#### Scenario: Abstaining voter counts as not done
- **WHEN** a voter errors or times out
- **THEN** that vote abstains and is counted as "not done" for the majority
- **AND** the gate still decides from the remaining successful votes plus the safe-side abstention

#### Scenario: Each vote is recorded durably
- **WHEN** the completion gate runs
- **THEN** the runtime records each individual vote and the final majority decision as durable event data

### Requirement: Loop termination is enforced by guardrails
The system SHALL enforce `maxSteps` and `maxDepth` bounds that terminate the loop regardless of planner decisions, so the loop cannot run unbounded.

#### Scenario: Depth bound stops runaway decomposition
- **WHEN** decomposition would exceed the configured `maxDepth`
- **THEN** the loop stops decomposing further and terminates with a recorded terminal state

#### Scenario: Bounds override planner advice
- **WHEN** the planner keeps emitting non-terminal decisions
- **THEN** the loop still terminates once a configured bound is reached, treating the planner's decisions as advisory

### Requirement: Loop runs deterministically under the mock provider
The system SHALL support running the loop and the quorum gate under the mock provider with deterministic planning, implementation, and voting, so the loop terminates predictably in tests.

#### Scenario: Mock loop completes deterministically
- **WHEN** a goal runs under the mock provider configured for the loop
- **THEN** the loop advances a fixed number of steps and reaches a completed terminal state deterministically

#### Scenario: Deterministic voters drive the gate
- **WHEN** the completion gate runs under deterministic mock voters
- **THEN** the majority outcome is deterministic and the recorded votes match the configured voters
