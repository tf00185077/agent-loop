## ADDED Requirements

### Requirement: Dashboard shows managed agent session state
The dashboard SHALL display available managed agent session state for a goal run, including provider, model, lifecycle state, safe summary, last activity, and pending approval status when present.

#### Scenario: Goal has an active session
- **WHEN** a user opens a goal detail view for a goal with an active managed agent session
- **THEN** the dashboard shows the session lifecycle state and provider/model metadata from backend session or event data

#### Scenario: Session metadata is missing
- **WHEN** historical goals or one-shot provider runs do not have managed session metadata
- **THEN** the dashboard still renders the goal detail and timeline without errors

### Requirement: Dashboard handles approval requests
The dashboard SHALL show pending approval requests for managed agent sessions and allow the user to approve or reject them through backend actions.

#### Scenario: Pending approval appears
- **WHEN** the backend emits or returns a pending approval request for the current goal
- **THEN** the dashboard shows the safe request summary and approve/reject controls

#### Scenario: User approves request
- **WHEN** the user approves a pending request from the dashboard
- **THEN** the dashboard calls the backend approval action and updates the visible request state from the backend response or streamed events

#### Scenario: User rejects request
- **WHEN** the user rejects a pending request from the dashboard
- **THEN** the dashboard calls the backend rejection action and updates the visible request state from the backend response or streamed events

### Requirement: Dashboard cancels managed sessions
The dashboard SHALL allow the user to cancel an active or waiting managed agent session through a backend action when the backend reports cancellation support.

#### Scenario: Cancellation is supported
- **WHEN** a running or waiting session reports cancellation support
- **THEN** the dashboard shows a cancel control that calls the backend session-cancel action

#### Scenario: Cancellation is unsupported
- **WHEN** a session or provider reports cancellation as unsupported
- **THEN** the dashboard does not show an actionable cancel control for that session

### Requirement: Dashboard keeps provider control backend-only
The dashboard SHALL perform session control through backend APIs only. It SHALL NOT directly attach to Codex, Claude, stdout, stderr, provider processes, local shells, or provider credential stores.

#### Scenario: Dashboard resolves approval
- **WHEN** a user approves or rejects an agent command from the dashboard
- **THEN** the dashboard sends only a backend API request
- **AND** provider-specific process control remains inside the backend runtime adapter

### Requirement: Dashboard explains unsupported control features
The dashboard SHALL show sanitized provider/runtime capability limitations when a selected local runtime cannot support approval, cancellation, resume, or child-session behavior.

#### Scenario: Approval is unsupported
- **WHEN** the backend reports that the selected runtime cannot support approval resolution
- **THEN** the dashboard shows a safe limitation message instead of an approve/reject workflow that cannot work
