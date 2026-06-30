## 1. Minimal Live Status Contract

- [ ] 1.1 Add domain tests for a minimal agent live status view model derived from durable goal events.
- [ ] 1.2 Define MVP status states: running, waiting_child, continuing, completed, failed, blocked, cancelled, and unknown.
- [ ] 1.3 Define derived fields for last activity time, provider/model context, agent role/id, parent agent id, task id, and safe status summary.
- [ ] 1.4 Specify how missing optional orchestration metadata is handled for current single-agent provider runs.

## 2. Status Derivation

- [ ] 2.1 Add tests that derive live status from run started, delegation waiting, child completed, continuation started, run terminal, cancellation, and error events.
- [ ] 2.2 Implement a deterministic status reducer that consumes events in durable timeline order.
- [ ] 2.3 Ensure child or continuation state is cleared when terminal events arrive.
- [ ] 2.4 Preserve safe summaries only; do not derive status from raw provider payloads.

## 3. Backend API Integration

- [ ] 3.1 Add backend tests for returning minimal derived live status for a goal.
- [ ] 3.2 Include derived status in an existing goal detail response or add a small goal-scoped status endpoint without breaking current clients.
- [ ] 3.3 Ensure status derivation works from snapshots after refresh and does not require an active SSE connection.
- [ ] 3.4 Add tests proving terminal goal states return stable completed, failed, blocked, or cancelled status.

## 4. Dashboard Status Rendering

- [ ] 4.1 Add dashboard rendering tests for minimal live status near the timeline.
- [ ] 4.2 Render compact current activity: provider/model, last activity, current state, and safe summary when available.
- [ ] 4.3 Render single-agent runs cleanly when agent id, parent agent id, or task id are absent.

## 5. Verification

- [ ] 5.1 Run focused domain reducer, backend status API, and dashboard status rendering tests.
- [ ] 5.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 5.3 Run `openspec validate add-agent-live-status-model --strict`.
