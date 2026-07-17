# goal-scale-decomposition (delta)

## MODIFIED Requirements

### Requirement: Contracted spec authoring
The system SHALL register one synthetic spec-writing task per planned change with frozen, machine-verifiable acceptance criteria (structural validation passes; every requirement has at least one scenario; every task carries acceptance criteria), executed as a standard worker delegation whose artifacts reach the goal workspace only through Supervisor semantic approval followed by the review-merge gate.

#### Scenario: Spec task is auto-registered
- **WHEN** a change plan is accepted
- **THEN** each change has a registered spec-writing task with the frozen structural criteria, delegable like any worker task

#### Scenario: Invalid spec artifacts are rejected with citations
- **WHEN** a spec-writer result fails structural validation
- **THEN** the backend records a substantive rejection citing the failing criteria and the existing retry/narrowing rules apply

#### Scenario: Spec artifacts merge through review after approval
- **WHEN** a spec-writer result passes validation in its worktree
- **THEN** the backend requests Supervisor semantic review, and the artifacts enter the goal workspace only via a Supervisor-approved review-merge outcome

#### Scenario: Zero-delivery spec results do not advance the change
- **WHEN** an accepted spec attempt carries no attested file changes
- **THEN** the backend rejects the delivery durably and the change remains in specifying with a corrective attempt required

### Requirement: Spec budget exhaustion blocks the change, not the goal
When a change's spec-authoring task exhausts its retry budget, the system SHALL durably block that change (`change.blocked` with the exhausted-budget reason), SHALL leave the goal status unchanged, and SHALL return a rejection observation that names reassessment and next-epoch re-planning as the recovery route. The goal SHALL transition to a terminal state only through the macro-loop bounds (epoch budget, repeated-gap circuit breaker) or explicit completion.

#### Scenario: Change blocks, goal survives
- **WHEN** spec authoring for a change exhausts its retry budget
- **THEN** the change is durably blocked, the goal remains `running`, and the supervisor observation names the reassess-and-re-plan route

#### Scenario: Blocked scope is re-planned in a next epoch
- **WHEN** all changes of the epoch are archived or blocked and the supervisor emits an unsatisfied reassessment whose structured gaps reference the blocked change
- **THEN** the backend admits the next-epoch plan under the existing admission gate
