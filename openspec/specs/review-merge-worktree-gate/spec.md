# review-merge-worktree-gate Specification

## Purpose

Define worker worktree isolation and the gated review/merge flow that applies worker output only after explicit supervisor review, clean workspace checkpointing, fixed-test verification, and revert validation.
## Requirements
### Requirement: Worker worktree isolation
The system SHALL run worker children in isolated local git worktrees and persist safe worktree metadata.

#### Scenario: Worker receives isolated worktree
- **WHEN** the backend spawns a worker child for delegated implementation work
- **THEN** the child runs with its cwd set to a dedicated git worktree and the worktree path or label is recorded durably

### Requirement: Review merge role
The system SHALL use the existing `review_merge` transport role as an independent judge that inspects a worker attempt, frozen criteria, candidate diff, and attested evidence and emits a validated structured decision; workspace apply and commit authority SHALL belong to deterministic backend delivery code.

#### Scenario: Supervisor requests independent review
- **WHEN** a supervisor emits a valid `review_merge` delegation request after a worker attempt exists
- **THEN** the backend spawns the review child with the frozen criteria, candidate evidence, and read access needed to decide every criterion

#### Scenario: Judge accepts all criteria
- **WHEN** the review child emits a valid decision marking every required criterion `PASS`
- **THEN** the backend persists the judge decision and starts backend delivery when attested workspace changes exist

#### Scenario: Judge rejects or blocks criteria
- **WHEN** the review child emits a valid decision with any criterion `FAIL` or `BLOCKED`
- **THEN** the backend records a substantive outcome and does not apply or commit the candidate changes

#### Scenario: Review is not automatic
- **WHEN** a worker child completes successfully
- **THEN** the backend records the worker attempt without automatically accepting the task or treating the worker's claims as a judge decision

### Requirement: Supervisor workspace checkpoint
The system SHALL require a clean supervisor workspace and checkpoint before review merge applies changes.

#### Scenario: Workspace is clean
- **WHEN** review merge starts and the supervisor workspace is clean
- **THEN** the backend records a pre-merge checkpoint before allowing apply behavior

#### Scenario: Workspace is dirty
- **WHEN** review merge starts and the supervisor workspace has uncommitted or untracked changes outside the accepted checkpoint policy
- **THEN** the backend rejects or fails review merge before applying worker changes

### Requirement: Merge outcome validation
The system SHALL derive delivery outcomes from backend-controlled apply, conditional integration recovery, validation, commit, and rollback operations and SHALL persist `committed`, `rejected`, `conflict`, `integration_failed`, `test_failed_reverted`, `revert_failed`, `failed`, or `verification_failed` as typed outcomes.

#### Scenario: Delivery succeeds
- **WHEN** the judge accepts the exact candidate being delivered, the backend applies it, and required validation passes
- **THEN** the backend records `committed` with diff summary, validation evidence, resulting commit SHA, and integration identity when present

#### Scenario: Judge rejects delivery
- **WHEN** the judge decision contains a required criterion that is not `PASS`
- **THEN** the backend records the review outcome without applying the candidate and leaves the supervisor workspace unchanged

#### Scenario: First conflict enters conditional recovery
- **WHEN** backend delivery cannot apply an accepted worker candidate because of conflicts and verified rollback succeeds
- **THEN** it records `conflict`, keeps the task unaccepted, and starts conditional integration recovery when no prior attempt exists

#### Scenario: Recovery cannot safely deliver
- **WHEN** conditional integration fails, the resolved candidate is not re-accepted, or final apply conflicts again
- **THEN** the backend records `integration_failed`, keeps the task unaccepted, verifies the supervisor checkpoint, and returns control to the Supervisor

### Requirement: Judge decisions authorize an exact candidate
The system SHALL bind every Judge decision used for delivery to the exact reviewed content identity, and a decision for an earlier candidate SHALL NOT authorize a resolved integration candidate.

#### Scenario: Candidate identity matches review
- **WHEN** backend delivery evaluates an accepted Judge decision
- **THEN** the decision's reviewed candidate identity matches the candidate selected for apply

#### Scenario: Candidate changed after acceptance
- **WHEN** integration or any other operation changes the candidate content after Judge acceptance
- **THEN** delivery remains blocked until a fresh valid decision covers the new candidate identity

### Requirement: Fixed test gate
The system SHALL run the configured fixed test command in the backend after applying an accepted candidate and SHALL require a successful exit before recording delivery as committed.

#### Scenario: Tests pass after apply
- **WHEN** backend delivery applies a candidate and the fixed test command exits successfully
- **THEN** the backend records the command, exit code, bounded safe output, and resulting commit SHA and marks delivery committed

#### Scenario: Tests fail after apply
- **WHEN** backend delivery applies a candidate and the fixed test command fails
- **THEN** the backend restores the supervisor workspace checkpoint and records `test_failed_reverted` only after verifying the restore

#### Scenario: Judge claims tests passed
- **WHEN** judge output claims validation passed but the backend fixed test command fails or was not run
- **THEN** the backend ignores the claim for delivery acceptance and follows the backend-observed result

### Requirement: Revert verification
The system SHALL verify supervisor workspace state after failed test or failed apply outcomes that require revert.

#### Scenario: Revert succeeds
- **WHEN** review merge reverts after a failed test
- **THEN** the backend verifies the workspace matches the pre-merge checkpoint and records revert evidence

#### Scenario: Revert fails
- **WHEN** review merge cannot restore the pre-merge checkpoint state
- **THEN** the backend records `revert_failed` or `verification_failed` with a safe summary

### Requirement: Judge decisions use a strict structured protocol
The system SHALL validate a `managed_review.decision` control block that identifies the worker attempt, declares an overall verdict, and provides exactly one `PASS`, `FAIL`, or `BLOCKED` decision for every frozen criterion.

#### Scenario: Complete decision is accepted
- **WHEN** review output contains a well-formed decision covering every and only the frozen criterion ids
- **THEN** the backend persists it as the authoritative judge decision for that attempt

#### Scenario: Incomplete or foreign decision is rejected
- **WHEN** a decision omits a criterion, repeats a criterion, references an unknown criterion, or targets a different worker attempt
- **THEN** the backend rejects the decision durably and leaves the task awaiting a valid review

### Requirement: Backend creates and applies candidate commits
The system SHALL create any candidate commit from the worker worktree under backend authority and SHALL apply it to a clean checkpointed supervisor workspace only after an accepted judge decision.

#### Scenario: Accepted dirty worktree becomes a candidate
- **WHEN** an accepted worker attempt has attested changes that still match its reviewed worktree state
- **THEN** the backend stages those changes and creates a runtime-owned candidate commit for delivery

#### Scenario: Worktree changed after review
- **WHEN** the worker worktree no longer matches the attested and reviewed state
- **THEN** the backend records verification failure and does not create, apply, or commit the candidate
