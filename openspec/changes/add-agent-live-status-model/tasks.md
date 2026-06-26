## Dependency

- [ ] 0.1 Complete `add-agent-observability-event-layer` first; this change depends on durable, sanitized agent observation events.
- [ ] 0.2 Confirm observation events include enough metadata to derive status: event kind, provider, model, source, agent id or role when present, task id when present, command lifecycle data, heartbeat or last-seen data, and terminal failure data.

## 1. Live Status Contract

- [ ] 1.1 Add domain tests for an agent live status view model derived from durable goal events.
- [ ] 1.2 Define status states for active agent work, including running, idle, waiting, stalled, completed, failed, blocked, and unknown.
- [ ] 1.3 Define derived fields for last activity time, current command, current task, provider/model context, agent role/id, parent agent id, task id, and safe status summary.
- [ ] 1.4 Specify how missing optional future orchestration metadata is handled for current single-agent provider runs.

## 2. Status Derivation

- [ ] 2.1 Add tests that derive live status from command-started, command-completed, command-failed, heartbeat, progress, subtask, run terminal, and error events.
- [ ] 2.2 Implement a deterministic status reducer that consumes events in durable timeline order.
- [ ] 2.3 Ensure stale command or task state is cleared when completion, failure, cancellation, or terminal events arrive.
- [ ] 2.4 Add stalled/no-recent-activity derivation using configurable thresholds without requiring heartbeat spam in the durable timeline.
- [ ] 2.5 Preserve safe summaries only; do not derive status from raw provider payloads.

## 3. Backend API Integration

- [ ] 3.1 Add backend tests for returning derived live status for a goal.
- [ ] 3.2 Add a goal-scoped live status endpoint or include derived status in an existing goal detail response without breaking current clients.
- [ ] 3.3 Ensure status derivation works from snapshots after refresh and does not require an active SSE connection.
- [ ] 3.4 Add tests proving terminal goal states return stable completed, failed, or blocked status.

## 4. Dashboard Status Rendering

- [ ] 4.1 Add dashboard state/rendering tests for live status above the timeline.
- [ ] 4.2 Render compact current activity: provider/model, last activity, running or stalled state, current command, current task, and safe summary when available.
- [ ] 4.3 Update status from streamed observation events without manual refresh.
- [ ] 4.4 Render single-agent runs cleanly when agent id, parent agent id, or task id are absent.
- [ ] 4.5 Avoid duplicating noisy heartbeat events in the primary timeline when a compact live status indicator is enough.

## 5. Failure and Waiting Diagnostics

- [ ] 5.1 Add tests for waiting or blocked states caused by sandbox denial, approval needed, login required, tool unavailable, command failure, timeout, or no progress before timeout when those observations are present.
- [ ] 5.2 Map known safe observation failure reasons into user-readable status summaries.
- [ ] 5.3 Ensure unknown failure reasons fall back to safe generic messages and do not expose raw provider output.

## 6. Verification

- [ ] 6.1 Run focused domain reducer, backend status API, and dashboard status rendering tests.
- [ ] 6.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 6.3 Run browser verification showing a long-running provider run updates compact status before final completion.
- [ ] 6.4 Run `openspec validate add-agent-live-status-model --strict`.
