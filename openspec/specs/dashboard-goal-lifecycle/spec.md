# dashboard-goal-lifecycle Specification

## Purpose

Define the dashboard-facing goal lifecycle for the vertical-slice MVP: how a local user creates, lists, views, starts, and observes goals through a minimal backend API surface.
## Requirements
### Requirement: Dashboard creates goals
The system SHALL allow a local user to create a goal from the dashboard by submitting a title, description, priority, and agent type.

#### Scenario: Goal is created from dashboard
- **WHEN** the user submits a valid goal creation form
- **THEN** the backend persists the goal and the dashboard can show the new goal in the goal list

### Requirement: Dashboard lists goals
The system SHALL allow the dashboard to list persisted goals with enough information to identify each goal and its current status.

#### Scenario: Goals are visible after refresh
- **WHEN** a user refreshes the dashboard after creating a goal
- **THEN** the goal list still shows the persisted goal and its current status

### Requirement: Dashboard shows goal detail
The system SHALL allow the dashboard to show a single goal's title, description, status, priority, agent type, and lifecycle timestamps.

#### Scenario: User opens goal detail
- **WHEN** the user selects a goal from the goal list
- **THEN** the dashboard shows that goal's persisted detail snapshot

### Requirement: Dashboard starts goals
The system SHALL allow the dashboard to start a persisted goal through a backend action endpoint.

#### Scenario: User starts a draft goal
- **WHEN** the user starts a draft goal from the goal detail view
- **THEN** the backend starts the mock runtime lifecycle for that goal and records durable progress events

### Requirement: Dashboard shows event timeline
The system SHALL allow the dashboard to display a goal's durable event timeline without requiring dedicated run or step query APIs.

#### Scenario: Timeline shows lifecycle progress
- **WHEN** a started goal has runtime events
- **THEN** the dashboard shows the goal's event timeline in creation order

### Requirement: Dashboard receives live goal events without polling
The system SHALL allow the dashboard to receive backend-pushed timeline events for a running goal without using periodic polling.

#### Scenario: Live event stream appends running events
- **WHEN** a user opens a running goal detail view
- **THEN** the dashboard subscribes to a backend event stream for that goal
- **AND** newly persisted goal events appear in the timeline without waiting for a manual refresh

#### Scenario: Snapshot remains the reconnect source of truth
- **WHEN** the dashboard opens or reconnects a goal timeline
- **THEN** it first loads the durable event snapshot through the existing events endpoint
- **AND** it deduplicates streamed events by event id when appending live updates

### Requirement: Dashboard does not poll for live timeline updates
The system SHALL NOT use a repeated timer or polling loop to update the running goal timeline.

#### Scenario: Running goal timeline is live
- **WHEN** a goal is running and the dashboard is displaying its timeline
- **THEN** live updates arrive through a pushed backend stream rather than repeated calls to the snapshot events endpoint

### Requirement: Live stream terminates cleanly at goal terminal state
The system SHALL allow the dashboard to stop listening for live events once the goal reaches a terminal state.

#### Scenario: Goal completes while stream is open
- **WHEN** a streamed event indicates the goal completed, failed, blocked, or was cancelled
- **THEN** the dashboard renders the terminal event and closes or stops relying on the live stream for that goal

### Requirement: Dashboard shows saved provider test progress
The dashboard SHALL show connection-test progress and the resulting provider status when Codex Local settings are automatically tested after save.

#### Scenario: Auto-test is running
- **WHEN** the dashboard has saved Codex Local provider settings and the automatic connection test is in progress
- **THEN** provider setup shows a testing state separate from the save action
- **AND** the user can tell the selected model is being validated

#### Scenario: Auto-test result is shown
- **WHEN** the automatic Codex Local connection test completes
- **THEN** provider setup shows the sanitized success or failure status returned by the backend

### Requirement: Dashboard identifies run provider and model
The dashboard SHALL display available provider and model metadata for goal runs and timeline events so users can tell which provider/model produced a run, response, or error.

#### Scenario: Goal detail shows latest run metadata
- **WHEN** a goal has durable events containing provider/model metadata for a run
- **THEN** the goal detail view shows the latest available provider and model for that goal

#### Scenario: Timeline shows event run metadata
- **WHEN** the event timeline renders an event with provider/model metadata
- **THEN** the timeline displays that metadata near the event type or message

#### Scenario: Missing metadata is tolerated
- **WHEN** historical events or generic lifecycle events do not include provider/model metadata
- **THEN** the dashboard still renders the timeline without an error

### Requirement: Dashboard uses minimal MVP API
The system SHALL support the first dashboard demo path with only goal creation, goal list, goal detail, goal start, and goal events API endpoints.

#### Scenario: Run and step query APIs are not required
- **WHEN** the dashboard shows the first MVP lifecycle
- **THEN** it does not require `GET /api/runs/:id`, `GET /api/goals/:id/steps`, pause, cancel, retry, or resume endpoints

### Requirement: Dashboard starts goals with current provider selection
The dashboard SHALL send the currently selected provider/model state when the user starts a draft goal, without requiring the user to save that selection first.

#### Scenario: User starts with unsaved Codex model selection
- **WHEN** the user selects Codex Local and a catalog model in provider setup but does not press Save
- **AND** the user starts a draft goal
- **THEN** the start request includes the selected Codex provider, model label, and command path for that run

#### Scenario: User starts with saved defaults only
- **WHEN** the dashboard has no current provider override state for a start action
- **THEN** starting a draft goal still works using saved provider settings

### Requirement: Save remains a persistent default action
The dashboard SHALL keep Save as the action that persists provider defaults, separate from the per-run start selection.

#### Scenario: User changes model and starts without saving
- **WHEN** the user changes the selected model and starts a goal without pressing Save
- **THEN** the run uses the selected model
- **AND** the persisted provider settings remain unchanged

### Requirement: Goal detail shows actual run provider metadata
The dashboard SHALL display provider/model metadata from the actual run events, not from the saved provider setup defaults.

#### Scenario: Run uses per-run override
- **WHEN** a goal was started with a provider override
- **THEN** the goal detail and timeline show the provider/model metadata recorded for that run

### Requirement: Dashboard displays live agent observability events
The dashboard SHALL display durable live agent observability events for active goal runs so users can tell whether work is progressing before the final response is available.

#### Scenario: Running provider emits observations
- **WHEN** a goal detail view is open and the active provider emits observability events
- **THEN** the dashboard appends those events to the timeline through the live event stream without manual refresh

#### Scenario: Observation snapshot is loaded after refresh
- **WHEN** the user refreshes a goal detail view after observability events were emitted
- **THEN** the dashboard loads those events from the durable events snapshot

### Requirement: Dashboard distinguishes observation kinds
The dashboard SHALL render agent observability events with enough semantic distinction for users to identify liveness, progress, command execution, subtask lifecycle, and failures.

#### Scenario: Command observation appears
- **WHEN** the timeline contains a command-started, command-completed, or command-failed observation
- **THEN** the dashboard displays the command state and safe summary without requiring the user to inspect raw stdout

#### Scenario: Heartbeat observation appears
- **WHEN** the timeline contains heartbeat or liveness observations
- **THEN** the dashboard displays them as activity indicators rather than final agent messages

#### Scenario: Subtask observation appears
- **WHEN** the timeline contains a subtask observation with agent or task metadata
- **THEN** the dashboard displays enough context to identify the delegated task or child agent when that metadata is present

### Requirement: Dashboard tolerates partial observation metadata
The dashboard SHALL render observability events even when optional future orchestration metadata is absent.

#### Scenario: Single-agent observation has no parent
- **WHEN** an observability event includes provider/model metadata but no parent agent id or task id
- **THEN** the dashboard renders the event without error

#### Scenario: Unknown observation source appears
- **WHEN** an observability event contains an unknown source or raw provider event type
- **THEN** the dashboard renders the safe message and known metadata without failing the timeline

### Requirement: Dashboard does not expose raw provider output by default
The dashboard SHALL show sanitized observability messages and bounded safe summaries by default rather than raw provider stdout, stderr, or JSONL payloads.

#### Scenario: Observation contains sanitized summary
- **WHEN** an observability event includes a safe summary and provider provenance
- **THEN** the dashboard displays the safe summary
- **AND** it does not display raw credential-bearing fields or raw provider event payloads

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
