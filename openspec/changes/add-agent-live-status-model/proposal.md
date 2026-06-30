## Why

The MVP delegation loop needs a compact answer to "what is happening right now?" without requiring users to infer supervisor, child, and review/merge state from raw events. This change keeps the status model minimal so it supports the MVP without becoming a full multi-agent dashboard project.

## What Changes

- Add a minimal live status model derived from durable goal, run, and agent events.
- Derive current state such as running, waiting on child, continuing, completed, failed, blocked, and unknown.
- Track safe current activity fields including last activity time, provider/model, agent role/id, parent agent id, task id, and status summary when available.
- Expose the derived status through the backend so refresh/reconnect uses durable history as the source of truth.
- Render a compact status in the dashboard near the event timeline.
- Defer rich stalled detection, SSE-specific live updates, full command/task activity modeling, browser-only verification, and multi-agent tree rendering to future work.

## Capabilities

### New Capabilities
- `agent-live-status`: Defines how durable agent events are reduced into a minimal current status for backend APIs and dashboard display.

### Modified Capabilities
- `dashboard-goal-lifecycle`: The dashboard SHALL show minimal derived current activity for a goal in addition to the durable event timeline.

## Impact

- Affects domain/view-model code for event-to-status reduction, backend goal response shape or status endpoint, dashboard goal detail rendering, and focused tests.
- Depends on durable, sanitized events being available.
- Adds no provider execution path, scheduler, distributed worker pool, multi-agent run tree, or rich live telemetry.
