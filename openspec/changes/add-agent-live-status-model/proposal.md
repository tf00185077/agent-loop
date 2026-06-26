## Why

After agent observation events exist, users still need a compact answer to "what is happening right now?" A raw event timeline can prove activity, but it forces users to infer whether a Codex or Claude-backed run is running, waiting, stalled, failed, or simply quiet.

## What Changes

- Add a live status model derived from durable goal events and agent observation events.
- Derive current state such as running, idle, waiting, stalled, completed, failed, blocked, and unknown.
- Track safe current activity fields including last activity time, current command, current task, provider/model, agent role/id, parent agent id, task id, and status summary.
- Expose the derived status through the backend so refresh/reconnect uses durable history as the source of truth.
- Render compact live status in the dashboard above or near the event timeline.
- Keep heartbeat noise out of the primary user experience by deriving liveness from events instead of requiring every heartbeat to be shown as a major timeline item.
- Do not implement multi-agent tree rendering or subagent scheduling in this change.

## Capabilities

### New Capabilities
- `agent-live-status`: Defines how durable agent observations are reduced into current agent/run status for backend APIs and dashboard display.

### Modified Capabilities
- `dashboard-goal-lifecycle`: The dashboard SHALL show derived current activity for a goal in addition to the durable event timeline.

## Impact

- Affects domain/view-model code for event-to-status reduction, backend goal status APIs or response shapes, dashboard goal detail rendering, and tests.
- Depends on `add-agent-observability-event-layer` being complete so structured observation events are available.
- Adds no new provider execution path, credential storage, scheduler, distributed worker pool, or multi-agent orchestration.
