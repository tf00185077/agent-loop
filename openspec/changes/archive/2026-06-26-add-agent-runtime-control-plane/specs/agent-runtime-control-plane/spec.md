## ADDED Requirements

### Requirement: Managed agent sessions
The system SHALL support managed agent sessions for interactive local coding-agent runtimes. A managed session SHALL have a durable session id, goal id, run id, provider id, model label when known, lifecycle state, creation timestamp, last-activity timestamp, and optional parent session metadata.

#### Scenario: Session starts for an interactive runtime
- **WHEN** a goal run starts with an interactive local runtime provider
- **THEN** the backend creates a durable agent session before invoking the provider adapter
- **AND** the session records the goal id, run id, provider id, model label when known, and a starting or running lifecycle state

#### Scenario: Session state survives refresh
- **WHEN** the dashboard reloads while an agent session is running or waiting
- **THEN** the backend returns the durable session snapshot without requiring access to raw provider process output

### Requirement: Runtime adapter contract
The system SHALL define a provider-agnostic runtime adapter contract for interactive coding agents. The contract SHALL let the backend start a session, consume runtime events, send user or system input, approve or reject pending approval requests, cancel the session, and inspect adapter capabilities.

#### Scenario: Mock adapter runs through the session contract
- **WHEN** a test injects a mock runtime adapter
- **THEN** the backend can start a session, receive runtime events, and complete or fail the run without importing Codex-specific or Claude-specific code

#### Scenario: Adapter reports unsupported capabilities
- **WHEN** a runtime adapter cannot support approval, resume, child-session requests, or another control-plane feature
- **THEN** the backend exposes that unsupported capability as sanitized session metadata or a durable error instead of hanging indefinitely

### Requirement: Session lifecycle states
The system SHALL represent interactive agent session lifecycle using provider-agnostic states for starting, running, waiting for approval, waiting for input, stalled, cancelling, cancelled, failed, and completed.

#### Scenario: Session waits for approval
- **WHEN** the runtime adapter emits an approval request for a command or provider action
- **THEN** the backend marks the session as waiting for approval and persists a durable event describing the safe approval summary

#### Scenario: Session reaches terminal state
- **WHEN** the runtime adapter reports completion, failure, cancellation, or an unrecoverable unsupported state
- **THEN** the backend records the corresponding terminal session state and persists a durable goal event

### Requirement: Approval requests
The system SHALL persist command or action approval requests created by interactive agent sessions. Each approval request SHALL include a durable request id, session id, safe summary, command metadata when available, status, created timestamp, and resolved timestamp when approved or rejected.

#### Scenario: Command approval is requested
- **WHEN** an agent session requests approval to run a local command
- **THEN** the backend persists a pending approval request with redacted command details
- **AND** the dashboard can display the request through backend APIs and durable events

#### Scenario: Approval request omits secrets
- **WHEN** a requested command or action contains credential-like material, auth cache paths, cookies, access tokens, API keys, or authorization headers
- **THEN** the persisted approval request and streamed event contain only redacted safe text

### Requirement: Approval resolution actions
The system SHALL expose backend-mediated approve and reject actions for pending approval requests. These actions SHALL update durable approval state, emit durable events, and forward the resolution to the active runtime adapter when the adapter supports it.

#### Scenario: User approves a pending request
- **WHEN** the dashboard approves a pending approval request
- **THEN** the backend marks the request approved, emits an approval-approved event, and tells the runtime adapter to continue the session

#### Scenario: User rejects a pending request
- **WHEN** the dashboard rejects a pending approval request with an optional safe reason
- **THEN** the backend marks the request rejected, emits an approval-rejected event, and tells the runtime adapter to continue or fail according to adapter capability and policy

#### Scenario: Approval action is idempotent
- **WHEN** an already resolved approval request receives a duplicate approve or reject action
- **THEN** the backend returns the existing resolved state without sending a second resolution to the runtime adapter

### Requirement: Session cancellation
The system SHALL allow a dashboard user to cancel an active or waiting agent session through the backend. Cancellation SHALL update durable session state, emit durable events, and request provider process termination through the runtime adapter.

#### Scenario: User cancels a running session
- **WHEN** the dashboard cancels a running agent session
- **THEN** the backend marks the session cancelling or cancelled, emits a cancellation event, and asks the adapter to stop the local agent process

#### Scenario: User cancels a waiting session
- **WHEN** the dashboard cancels a session that is waiting for approval or user input
- **THEN** the backend resolves the visible session as cancelled and prevents later approval actions from resuming the session

### Requirement: Runtime events are durable timeline events
The system SHALL map provider-agnostic runtime events into durable goal events before streaming them to the dashboard. Runtime events SHALL include safe metadata for session id, provider, model, command id, approval request id, agent id, parent agent id, and task id when available.

#### Scenario: Runtime event is persisted before streaming
- **WHEN** an active runtime adapter emits a command, progress, approval, child-session, completion, or failure event
- **THEN** the backend persists the event as a durable goal event before publishing it through the live stream

#### Scenario: Dashboard reconnects after runtime events
- **WHEN** the dashboard reconnects to a goal after runtime events were emitted
- **THEN** the durable event snapshot includes those events in timeline order

### Requirement: Child-session requests
The system SHALL define provider-agnostic child-session request semantics for future main-agent/subagent orchestration. A child-session request SHALL include the parent session id, parent agent id when available, child role, task id when available, prompt or work summary, and request status.

#### Scenario: Main session requests a child session
- **WHEN** a runtime adapter or future scheduler requests delegated work
- **THEN** the backend persists a child-session request with parent/child metadata and emits a durable event

#### Scenario: Child-session scheduling is unsupported
- **WHEN** child-session requests are not enabled in the current runtime configuration
- **THEN** the backend records the request as unsupported or rejected with a safe reason rather than silently dropping it

### Requirement: Orphaned process recovery state
The system SHALL handle backend restart or adapter loss without presenting stale in-memory process state as active control state. If an active session cannot be reattached, the system SHALL mark it stalled, failed, or cancelled according to explicit recovery policy and persist a durable event.

#### Scenario: Backend restarts during a session
- **WHEN** the backend starts and finds a non-terminal durable agent session without an attached adapter process
- **THEN** it applies recovery policy and records a visible durable state transition rather than leaving the session running indefinitely

### Requirement: Windows-safe command guidance
The system SHALL preserve local platform command context in safe session diagnostics so agent runs can distinguish command failures from agent reasoning failures. On Windows, the system SHALL be able to surface sanitized guidance for blocked PowerShell script commands such as `npm.ps1` execution-policy failures.

#### Scenario: PowerShell execution policy blocks npm script
- **WHEN** an agent command fails because PowerShell blocks a `.ps1` shim such as `npm.ps1`
- **THEN** the backend records sanitized diagnostic context that can guide a retry with a safe executable such as `npm.cmd` without exposing secrets
