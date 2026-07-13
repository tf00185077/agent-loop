# managed-delegation-core Specification

## Purpose

Define the durable backend-managed delegation core for supervisor and worker sessions, including delegation request state, one-active-child enforcement, child outcome recording, supervisor continuation, and detached child result handling.

## Requirements
### Requirement: Durable delegation request state
The system SHALL persist backend-managed delegation requests as first-class durable state separate from parent-child session metadata.

#### Scenario: Delegation request is accepted
- **WHEN** a running supervisor emits a valid delegation control event
- **THEN** the backend persists a delegation request linked to the supervisor session and records an accepted status

#### Scenario: Delegation request survives restart
- **WHEN** the backend reloads after a delegation request was accepted
- **THEN** the persisted request identifies the parent session, child session when created, role, status, timestamps, and latest safe summary without reading provider output

### Requirement: One active child per supervisor
The system SHALL allow at most one active child delegation for a supervisor session in v1.

#### Scenario: Active child exists
- **WHEN** a supervisor with an active child emits another valid delegation request
- **THEN** the backend rejects the new request and records a safe rejection reason

### Requirement: Maximum delegation depth
The system SHALL reject nested delegation in v1.

#### Scenario: Child requests child
- **WHEN** a child session emits a delegation request
- **THEN** the backend rejects the request and records that maximum delegation depth has been reached

### Requirement: Worker child session spawning
The system SHALL spawn accepted `worker` child sessions through backend-managed runtime APIs.

#### Scenario: Worker child starts
- **WHEN** the backend accepts a `worker` delegation request
- **THEN** it creates a child agent session linked to the supervisor and records a durable delegation-started event

### Requirement: Child outcomes
The system SHALL record child success, failure, timeout, and cancellation outcomes without automatically failing the supervisor goal.

#### Scenario: Child succeeds
- **WHEN** a child session completes successfully
- **THEN** the backend records the child result summary and marks the delegation request completed

#### Scenario: Child fails
- **WHEN** a child session fails, times out, or is cancelled
- **THEN** the backend records the failure summary and keeps the supervisor goal eligible for continuation

### Requirement: Supervisor continuation after child result
The system SHALL return non-detached child outcomes to the supervisor as observations and continue the supervisor.

#### Scenario: Provider supports true resume
- **WHEN** a child result is recorded and the supervisor provider supports true resume
- **THEN** the backend resumes the supervisor session with the child result observation

#### Scenario: Provider lacks true resume
- **WHEN** a child result is recorded and true resume is unavailable
- **THEN** the backend starts a fresh supervisor continuation with summarized child result context

### Requirement: Detached child outcomes
The system SHALL preserve active child execution when the supervisor becomes terminal and mark late child results as detached or ignored.

#### Scenario: Supervisor cancelled while child runs
- **WHEN** the supervisor is cancelled while a child session remains active
- **THEN** the backend records that the supervisor no longer awaits the child result and leaves the child running

#### Scenario: Child finishes after supervisor terminal state
- **WHEN** a child finishes after its supervisor is terminal
- **THEN** the backend stores the child outcome as detached or ignored and does not continue the supervisor

### Requirement: Sequential delegations across supervisor lifetime
The system SHALL allow a supervisor session to issue multiple delegation requests sequentially over its lifetime, while still enforcing at most one active child at a time and maximum depth one.

#### Scenario: Second delegation after first child completes
- **WHEN** a supervisor whose previous child delegation reached a terminal state emits a new valid delegation request
- **THEN** the backend accepts the new request and starts the next child session

#### Scenario: Delegation requests preserve order
- **WHEN** multiple delegation requests have been recorded for one supervisor
- **THEN** the persisted requests reconstruct the delegation sequence in order with their roles, task identifiers when present, statuses, and result summaries

### Requirement: Managed goal completion requires supervisor completion signal
The system SHALL complete a managed supervisor goal only on an explicit supervisor completion signal or a terminal failure, cancellation, or configured bound; a supervisor provider process exiting SHALL NOT by itself mark the goal completed.

#### Scenario: Supervisor process exits mid-goal
- **WHEN** a supervisor session's provider process exits without a completion signal while no delegation is pending
- **THEN** the goal remains non-terminal and the backend starts a bounded supervisor continuation

#### Scenario: Completion signal completes the goal
- **WHEN** the supervisor emits a valid completion signal
- **THEN** the backend marks the supervisor session, run, and goal completed and records the safe result summary

### Requirement: Bounded completion-less continuations
The system SHALL enforce a configured maximum number of supervisor continuations started because a session ended without a completion signal, and SHALL mark the goal blocked with a durable reason when the bound is reached.

#### Scenario: Continuation bound is exhausted
- **WHEN** completion-less supervisor continuations reach the configured maximum
- **THEN** the backend marks the goal blocked, records the bound and reason durably, and starts no further continuations

### Requirement: Delegation requests persist their acceptance contract
The system SHALL persist the frozen acceptance criteria in force for a worker delegation on the delegation request itself, so the contract a child was dispatched under is reconstructable without replaying supervisor output.

#### Scenario: Contract is stored at dispatch
- **WHEN** the backend accepts a worker delegation for a task with acceptance criteria
- **THEN** the persisted delegation request includes the frozen criteria snapshot in force at dispatch

#### Scenario: Contract survives restart
- **WHEN** the backend reloads after a contracted delegation was dispatched
- **THEN** the delegation request still exposes the criteria snapshot alongside role, status, and result fields

### Requirement: Delegation results carry structured evidence
The system SHALL extend delegation result summaries with optional structured fields for per-criterion evidence, executed tests, child-claimed changed files, and backend-attested changed files, without breaking consumers of the existing safe summary.

#### Scenario: Structured result is persisted
- **WHEN** a child terminal outcome includes structured evidence
- **THEN** the delegation request's result records criterion evidence, tests, claimed files, and attested files alongside the safe summary

#### Scenario: Legacy summary-only results remain valid
- **WHEN** a child terminal outcome carries only a safe summary
- **THEN** the delegation result persists as before with structured fields absent

### Requirement: Durable rejection lineage per task
The system SHALL persist, per task, the count of substantive rejections, the criterion identifiers cited by each rejection, and the lineage between a task and any narrower tasks it was split into.

#### Scenario: Substantive rejection is recorded on the lineage
- **WHEN** a task result receives a substantive rejection citing criterion identifiers
- **THEN** durable events record the incremented rejection count and the cited criteria for that task

#### Scenario: Split lineage is recorded
- **WHEN** a task past the narrowing threshold is split into narrower tasks
- **THEN** durable events record the parent task identifier on each narrower task

### Requirement: Children spawn through role-resolved adapters
The system SHALL spawn child sessions through the adapter resolved for the delegation's role rather than unconditionally inheriting the parent session's adapter, using the resolved provider and model for child capability detection, session records, and run rows.

#### Scenario: Worker child uses the resolved adapter
- **WHEN** a delegation dispatches with a role-resolved adapter differing from the parent's
- **THEN** the child session starts through the resolved adapter and its run row records the resolved provider and model

#### Scenario: Parent adapter remains the default
- **WHEN** no role resolution applies
- **THEN** the child spawns through the parent session's adapter with unchanged provider and model recording

### Requirement: Delegations carry their change identifier
The system SHALL persist an optional change identifier on delegation requests and carry it in delegation lifecycle event metadata, so per-change execution state is reconstructable from durable records.

#### Scenario: Delegation records its change
- **WHEN** a worker delegation is dispatched while a change plan is active
- **THEN** the persisted delegation request and its lifecycle events carry the active change identifier

#### Scenario: Plan-less goals are unaffected
- **WHEN** a goal has no change plan
- **THEN** delegation requests persist without a change identifier exactly as before

### Requirement: One active change per goal
The system SHALL enforce at most one active change per goal at the delegation control plane, as the plan-level sibling of the one-active-child rule.

#### Scenario: Work outside the active change is rejected
- **WHEN** a delegation control event targets a planned change that is not currently active
- **THEN** the backend rejects it durably and execution of the active change is unaffected
