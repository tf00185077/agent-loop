## Why

The runtime control plane can describe managed sessions, approvals, and future child-session requests, but production Codex runs still need a concrete delegation and authority model before hierarchical agent work can be controlled safely. Users want Codex-started agents to have visible relationships and request additional authority only when needed, even when the current Codex CLI mode cannot resume an existing paused approval.

## What Changes

- Add a delegated-agent authority control capability for local single-user managed agent sessions.
- Treat Codex-spawned delegated agents as backend-managed sessions with durable relationship metadata, rather than hidden provider subprocesses.
- Add just-in-time authority requests that can be approved or rejected through the backend/dashboard.
- Add authority grants with explicit scope, requester, approver, timestamps, status, and sanitized summaries.
- Define a restart-as-continuation fallback: when a runtime cannot resume after authority approval, the backend starts a new authorized managed session with the prior task, safe history summary, relationship metadata, and grant scope.
- Require production Codex Local interactive starts to use the managed runtime adapter path when configured as an interactive runtime, so delegated authority is not hidden behind the one-shot provider smoke path.
- Keep full distributed scheduling, multi-user permission policy, remote workers, and irreversible auto-approval outside this change.

## Capabilities

### New Capabilities
- `delegated-agent-authority-control`: Defines delegated managed agent relationships, just-in-time authority requests, authority grants, and restart-as-continuation fallback behavior.

### Modified Capabilities
- `agent-runtime-control-plane`: Managed sessions SHALL carry delegation/supervision metadata and support authority-request events in addition to command approval requests.
- `model-provider-integration`: Codex Local interactive runtime starts SHALL be wired through the managed runtime adapter in production when interactive session control is selected, with clear fallback only for explicitly one-shot providers.
- `dashboard-goal-lifecycle`: The dashboard SHALL show delegated session relationships, authority requests, grant/reject actions, unsupported resume limitations, and restart-as-continuation outcomes through backend APIs only.

## Impact

- Affects domain contracts for managed sessions, delegation metadata, authority request records, authority grant records, and runtime events.
- Affects SQLite persistence for delegated session relationships, authority requests, grant state, and continuation links.
- Affects backend session-control APIs for requesting, approving, rejecting, and materializing authority grants.
- Affects Codex runtime adapter wiring so production Codex Local interactive runs use managed sessions before delegation or authority control is exercised.
- Affects dashboard goal detail controls for pending authority requests and delegated session visibility.
- Coordinates with `add-agent-live-status-model` and `add-multi-agent-run-tree`, which should consume delegated session metadata and authority states when deriving current status or tree nodes.
- Does not add distributed workers, remote execution, multi-user authorization, credential storage, or a complete autonomous scheduler.
