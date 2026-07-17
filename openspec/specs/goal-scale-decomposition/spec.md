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

### Requirement: Change archive readiness uses durable lineage
The system SHALL evaluate the active change's registered task closure through the shared durable lineage projection before archiving. A valid split parent SHALL be satisfied only through all required leaf descendants, and any `invalid_split_lineage` gap SHALL block archive with the same semantics used by Goal completion.

#### Scenario: Accepted split descendants satisfy archive
- **WHEN** an active change contains a valid durably `split` parent whose complete required leaf closure is accepted and all other archive gates pass
- **THEN** the parent does not remain an undelivered archive blocker and the backend may archive the change

#### Scenario: Invalid lineage blocks archive and completion alike
- **WHEN** the active change contains a parent with children but without a valid split transition
- **THEN** archive and Goal completion both fail with `invalid_split_lineage` for the same affected tasks

### Requirement: Archive blockers are durably visible
The system SHALL persist a sanitized `change.archive_blocked` event for every attempted active-change archive that fails a precondition. The event SHALL name the change, a stable blocker type, bounded affected logical task identifiers when applicable, and a safe reason; an archive attempt SHALL never return silently.

#### Scenario: Undelivered task blocks archive
- **WHEN** the backend attempts to archive an active change whose durable leaf closure contains an unaccepted task
- **THEN** it records `change.archive_blocked` with blocker type `undelivered_task` and the affected logical task identifier

#### Scenario: Invalid lineage blocks archive visibly
- **WHEN** the backend attempts to archive an active change with an invalid durable lineage
- **THEN** it records `change.archive_blocked` with blocker type `invalid_split_lineage`, the affected tasks, and the stable lineage reason

#### Scenario: Unmerged evidence remains visible
- **WHEN** all task lineage is satisfied but attested worker changes remain unmerged
- **THEN** the backend records `change.archive_blocked` with blocker type `unmerged_changes`

### Requirement: OpenSpec archive mutations remain backend owned
The system SHALL reserve OpenSpec archive and main-spec synchronization mutations to backend operations. A provider-controlled Worker or spec-writer candidate that adds, removes, or modifies an archive directory, modifies main specs as an archive/sync side effect, or deletes active-change artifacts SHALL be rejected by a deterministic backend path validator and SHALL NOT be delivered.

#### Scenario: Worker runs an archive command
- **WHEN** a Worker candidate deletes the active change and creates or modifies its dated archive or synchronized main specs
- **THEN** the backend records a reserved-path rejection and does not allow Judge acceptance to authorize delivery of that candidate

#### Scenario: Spec writer edits active artifacts only
- **WHEN** a spec writer adds or modifies required artifacts inside the active change without touching reserved archive/sync paths or deleting active artifacts
- **THEN** the candidate remains eligible for the existing structural validation and review-merge gates

#### Scenario: Backend archives an eligible change
- **WHEN** all archive gates pass and the backend invokes its internal archive operation
- **THEN** the backend may move the active change and synchronize main specs under backend authority

#### Scenario: Database-backed archive capability is unavailable
- **WHEN** a database-backed Goal reaches archive readiness but the workspace service cannot prepare a durable archive identity
- **THEN** the backend records `change.archive_blocked` with blocker type `archive_capability_unavailable`
- **AND** it does not invoke the legacy archive path, emit `change.archived`, or activate the next change

### Requirement: Backend archive reconciliation is write-ahead and fail closed
The system SHALL persist a Goal/change-scoped archive operation intent containing the exact source, dated target, validated manifest digest, and workspace checkpoint before filesystem or Git mutation. It SHALL finalize `change.archived` only after the exact target and backend Git result are verified, and SHALL reconcile a retry idempotently only from that intent.

#### Scenario: Restart before archive move
- **WHEN** restart finds a pending intent whose matching source exists, target is absent, and manifest/checkpoint still match
- **THEN** the backend continues the recorded archive operation without creating a second intent or target

#### Scenario: Restart after move before durable finalization
- **WHEN** restart finds a pending intent whose source is absent and exact target exists with the recorded digest
- **THEN** the backend proves exactly one coherent source-to-target archive commit between the recorded checkpoint and current HEAD, or completes and verifies that commit
- **AND** it records exactly one terminal archive operation and `change.archived` event

#### Scenario: Archive workspace contains unrelated state
- **WHEN** archive preparation finds unrelated dirty or staged paths, or the candidate archive commit contains any path outside the exact source-to-target move
- **THEN** the backend fails closed without committing the unrelated state or finalizing the archive operation

#### Scenario: Archive manifest changes after preparation
- **WHEN** source or dated-target content changes after durable archive preparation and before the backend commit is finalized
- **THEN** the backend recomputes the canonical target manifest and verifies the unique archive commit tree against the recorded digest
- **AND** any mismatch blocks finalization and next-change activation

#### Scenario: Pending archive commit identity is ambiguous
- **WHEN** zero, multiple, conflicting, or recorded-SHA-mismatched archive commits exist between the pre-archive checkpoint and current HEAD
- **THEN** reconciliation durably blocks and does not adopt current HEAD as the archive commit identity

#### Scenario: Finalized archive is retried
- **WHEN** archive is requested again for a terminal operation whose exact target and digest remain present
- **THEN** reconciliation is an idempotent no-op and does not create a duplicate archive event or directory

#### Scenario: Archive topology is ambiguous
- **WHEN** source and target both exist, neither exists, multiple matching archives exist, digest/path/checkpoint differs, or a target exists without a matching durable intent
- **THEN** the backend records `change.archive_blocked` with blocker type `archive_state_ambiguous` and performs no adoption, move, commit, activation, or Goal transition

#### Scenario: Restart lacks durable archive preparation capability
- **WHEN** restart finds a database-backed active change with no archive operation and the workspace service cannot prepare durable archive identity
- **THEN** the backend records `change.archive_blocked` with blocker type `archive_capability_unavailable`, leaves the Goal blocked, and starts no provider

### Requirement: Spec budget exhaustion blocks the change, not the goal
When a change's spec-authoring task exhausts its retry budget, the system SHALL durably block that change (`change.blocked` with the exhausted-budget reason), SHALL leave the goal status unchanged, and SHALL return a rejection observation that names reassessment and next-epoch re-planning as the recovery route. The goal SHALL transition to a terminal state only through the macro-loop bounds (epoch budget, repeated-gap circuit breaker) or explicit completion.

#### Scenario: Change blocks, goal survives
- **WHEN** spec authoring for a change exhausts its retry budget
- **THEN** the change is durably blocked, the goal remains `running`, and the supervisor observation names the reassess-and-re-plan route

#### Scenario: Blocked scope is re-planned in a next epoch
- **WHEN** all changes of the epoch are archived or blocked and the supervisor emits an unsatisfied reassessment whose structured gaps reference the blocked change
- **THEN** the backend admits the next-epoch plan under the existing admission gate

