## Why

Users need to observe agent progress while a run is still executing, not only after the dashboard fetches a completed event snapshot. The current provider-backed paths spawn local CLI processes but only persist the final response or error, so intermediate process output is not visible in the goal timeline.

## What Changes

- Add a backend-pushed live event stream for a goal's runtime events; do not use dashboard polling for live updates.
- Capture provider process output chunks from local CLI-backed providers and persist safe, non-secret progress events when meaningful output is available.
- Update the dashboard event timeline to subscribe while a goal is running and append events as they arrive.
- Keep the existing `GET /api/goals/:id/events` endpoint as the durable snapshot and refresh fallback.
- Treat provider stdout/stderr as untrusted: sanitize output, avoid credential leakage, and preserve final provider result/error behavior.
- Document and test provider-specific stream behavior, including the fact that Codex currently uses `codex exec --output-last-message` and may not emit useful stdout unless the invocation supports streamable output.

## Capabilities

### New Capabilities

### Modified Capabilities
- `dashboard-goal-lifecycle`: Adds live, backend-pushed event timeline observation for running goals.
- `model-provider-integration`: Adds safe process-output capture and durable progress events for local CLI-backed provider runs.

## Impact

- Affects backend goal event APIs, dashboard event timeline state management, provider process spawning, event persistence, and tests.
- Does not add WebSocket infrastructure, distributed workers, multi-user fan-out, or polling-based live updates.
- Does not expose raw provider credentials, command secret arguments, auth caches, cookies, or access tokens.
