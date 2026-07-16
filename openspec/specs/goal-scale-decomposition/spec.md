# goal-scale-decomposition Specification

## Purpose

Define the goal→changes decomposition tier: supervisors split oversized goals
into ordered OpenSpec changes via a validated change-plan control block, the
backend owns OpenSpec materialization/validation/archiving with visible
degradation, spec authoring runs as contracted worker delegations, changes
execute strictly one at a time, and change completion requires merged
evidence before the goal may complete.

## Requirements

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

### Requirement: Backend-owned OpenSpec materialization
The system SHALL scaffold, structurally validate, and archive OpenSpec change artifacts in the goal workspace through backend-executed operations; agents SHALL NOT be required to run the OpenSpec CLI or load OpenSpec workflow skills.

#### Scenario: Scaffolding is materialized and committed
- **WHEN** a change plan is accepted in a git-backed goal workspace
- **THEN** the backend materializes the OpenSpec change scaffolding and commits it so child worktrees can see it

#### Scenario: CLI validation gates spec artifacts
- **WHEN** spec artifacts for a change are submitted and the OpenSpec CLI is detected
- **THEN** the backend runs strict validation as an acceptance gate and rejects results whose artifacts do not validate

#### Scenario: Missing CLI degrades visibly
- **WHEN** the OpenSpec CLI cannot be detected
- **THEN** the backend records a durable downgrade event once per goal, renders scaffolding from internal templates, and substitutes internal structural checks and archive moves

### Requirement: Contracted spec authoring
The system SHALL register one synthetic spec-writing task per planned change with frozen, machine-verifiable acceptance criteria (structural validation passes; every requirement has at least one scenario; every task carries acceptance criteria), executed as a standard worker delegation whose artifacts reach the goal workspace only through the review-merge gate.

#### Scenario: Spec task is auto-registered
- **WHEN** a change plan is accepted
- **THEN** each change has a registered spec-writing task with the frozen structural criteria, delegable like any worker task

#### Scenario: Invalid spec artifacts are rejected with citations
- **WHEN** a spec-writer result fails structural validation
- **THEN** the backend records a substantive rejection citing the failing criteria and the existing retry/narrowing rules apply

#### Scenario: Spec artifacts merge through review
- **WHEN** a spec-writer result passes validation in its worktree
- **THEN** the artifacts enter the goal workspace only via a successful review-merge outcome

### Requirement: One active change sequencing
The system SHALL execute planned changes strictly one at a time in dependency-then-plan order, and SHALL reject task lists and worker delegations that reference a change other than the active one with a safe reason naming the active change.

#### Scenario: Out-of-order work is rejected
- **WHEN** a supervisor delegates work referencing a change that is not active
- **THEN** the backend rejects the delegation and names the currently active change

#### Scenario: Next change activates after archive
- **WHEN** the active change archives
- **THEN** the backend activates the next change in order and records the transition durably

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
