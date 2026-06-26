## ADDED Requirements

### Requirement: Dashboard shows delegated session relationships
The dashboard SHALL display available delegated managed session relationships for a goal, including supervisor session, delegating session, delegation role, task id, lifecycle state, provider/model, and safe task summary.

#### Scenario: Goal has delegated sessions
- **WHEN** a user opens a goal detail view for a goal with delegated managed sessions
- **THEN** the dashboard shows the delegated sessions and their relationship to the supervising session

#### Scenario: Delegation metadata is partial
- **WHEN** a delegated session has missing optional task or role metadata
- **THEN** the dashboard still renders the session with available safe metadata and does not fail the goal detail view

### Requirement: Dashboard handles authority requests
The dashboard SHALL show pending authority requests for managed sessions and allow the user to approve or reject them through backend actions.

#### Scenario: Pending authority request appears
- **WHEN** the backend emits or returns a pending authority request for the current goal
- **THEN** the dashboard shows the safe request summary, requested scope, requesting session, and approve/reject controls

#### Scenario: User approves authority request
- **WHEN** the user approves a pending authority request from the dashboard
- **THEN** the dashboard calls the backend authority approval action and updates the visible request/grant state from the backend response or streamed events

#### Scenario: User rejects authority request
- **WHEN** the user rejects a pending authority request from the dashboard
- **THEN** the dashboard calls the backend authority rejection action and updates the visible request state from the backend response or streamed events

### Requirement: Dashboard shows continuation fallback
The dashboard SHALL show when an approved authority request used restart-as-continuation instead of resuming the original runtime process.

#### Scenario: Authority approval starts continuation session
- **WHEN** the backend approves authority by starting a continuation session
- **THEN** the dashboard shows the original session, continuation session, approved grant, and continuation relationship

#### Scenario: Resume is unsupported
- **WHEN** the backend reports that the selected runtime cannot resume after authority approval
- **THEN** the dashboard shows a safe limitation message and does not imply that the original process will continue in place

### Requirement: Dashboard keeps delegated authority backend-only
The dashboard SHALL perform delegated authority control through backend APIs only. It SHALL NOT directly attach to Codex, Claude, stdout, stderr, local shells, provider processes, or provider credential stores.

#### Scenario: Dashboard resolves authority request
- **WHEN** a user approves or rejects delegated authority from the dashboard
- **THEN** the dashboard sends only a backend API request
- **AND** provider-specific process control and continuation behavior remain inside the backend runtime/session manager
