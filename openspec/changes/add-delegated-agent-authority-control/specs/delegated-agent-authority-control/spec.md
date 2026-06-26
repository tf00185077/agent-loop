## ADDED Requirements

### Requirement: Delegated managed agent sessions
The system SHALL represent Codex-started delegated agents as managed agent sessions with durable relationship metadata. Relationship metadata SHALL include the delegated session id, goal id, run id, provider id, model label when known, supervisor session id when available, delegating session id when available, delegation role, task id when available, safe task summary, creation timestamp, and current lifecycle state.

#### Scenario: Delegated session is created
- **WHEN** a managed agent session requests delegated agent work
- **THEN** the backend creates or records a managed delegated session with supervisor/delegation metadata
- **AND** the delegated session is visible through durable backend snapshots after refresh

#### Scenario: Delegated session is not hidden in provider output
- **WHEN** Codex starts delegated agent work through the supported backend path
- **THEN** the delegated agent relationship is represented as structured backend state
- **AND** the dashboard does not need to infer the relationship from raw provider stdout, stderr, JSONL, or free-form messages

### Requirement: Just-in-time authority requests
The system SHALL allow a managed agent session to request additional authority during execution. An authority request SHALL include a durable request id, requesting session id, requested capability scope, safe summary, status, created timestamp, resolved timestamp when available, and optional task/session boundary metadata.

#### Scenario: Delegated agent requests authority
- **WHEN** a delegated managed session needs authority outside its current grant scope
- **THEN** the backend persists a pending authority request with a safe summary and requested scope
- **AND** the goal timeline records a durable event before the request is shown to the dashboard

#### Scenario: Authority request omits secrets
- **WHEN** an authority request summary or scope includes credential-like material, auth cache paths, cookies, access tokens, API keys, or authorization headers
- **THEN** the persisted request, dashboard response, and streamed event contain only redacted safe text

### Requirement: Authority grant decisions
The system SHALL expose backend-mediated approve and reject actions for pending authority requests. Approval SHALL create a durable authority grant with explicit scope, requester, approver type, status, timestamps, and safe rationale. Rejection SHALL record a durable rejection reason without granting capability.

#### Scenario: User approves authority request
- **WHEN** the dashboard approves a pending authority request
- **THEN** the backend marks the request approved, creates a durable authority grant, and emits a durable grant event

#### Scenario: User rejects authority request
- **WHEN** the dashboard rejects a pending authority request with an optional safe reason
- **THEN** the backend marks the request rejected and emits a durable rejection event without creating an active grant

#### Scenario: Authority decision is idempotent
- **WHEN** an already resolved authority request receives a duplicate approve or reject action
- **THEN** the backend returns the existing resolved state without creating a second grant or sending a second runtime control action

### Requirement: Grant scope enforcement metadata
The system SHALL attach active authority grant scope metadata to any managed continuation or runtime control action that depends on that grant. Grant scope SHALL be bounded to the target session, task, continuation session, or terminal lifecycle boundary according to the grant record.

#### Scenario: Granted authority is scoped
- **WHEN** an approved authority request grants workspace-write authority for a delegated task
- **THEN** the grant record identifies the delegated task/session boundary for which the authority applies
- **AND** unrelated sessions do not inherit that authority by default

#### Scenario: Grant scope is visible
- **WHEN** the dashboard loads a delegated session snapshot
- **THEN** it can display the active safe grant scopes and their requester/approver metadata without exposing provider credentials

### Requirement: Restart-as-continuation fallback
The system SHALL support restart-as-continuation when a runtime cannot resume an active session after authority approval. The continuation session SHALL link to the prior session, preserve supervisor/delegation metadata, include the approved grant scope, and receive a safe task/history summary.

#### Scenario: Runtime cannot resume after grant
- **WHEN** an authority request is approved for a session whose runtime reports resume as unsupported
- **THEN** the backend starts a new managed continuation session with the approved grant scope
- **AND** the prior session records a visible superseded, cancelled, failed, or otherwise terminal transition with continuation metadata

#### Scenario: Continuation is visible after refresh
- **WHEN** the dashboard reloads after restart-as-continuation
- **THEN** the prior session, continuation session, authority grant, and continuation link are visible from durable backend state

### Requirement: Delegated authority event durability
The system SHALL map delegated-session, authority-request, grant, rejection, and continuation events into durable goal timeline events before streaming them to the dashboard.

#### Scenario: Authority event is persisted before streaming
- **WHEN** the backend creates or resolves an authority request
- **THEN** it persists the corresponding goal event before publishing it through the live stream

#### Scenario: Dashboard reconnects after authority event
- **WHEN** the dashboard reconnects after delegated authority events were emitted
- **THEN** the durable event snapshot includes those events in timeline order
