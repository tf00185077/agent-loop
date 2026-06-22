## Why

Codex Local setup currently asks the user to save a model and then manually run a connection test, but the test is also the practical warm-up path that proves the selected model can answer before a goal starts. When a run later fails, the dashboard timeline does not make it obvious which provider and model produced that run, making timeouts and mixed mock/Codex events hard to diagnose.

## What Changes

- Automatically run the existing Codex Local connection test after saving Codex Local provider settings with a command path and selected model/default choice.
- Surface auto-test progress and results in provider setup so the user can see whether the saved selection is ready for goal runs.
- Keep manual **Test connection** available for retry/debugging.
- Display provider/model metadata for a goal run in the dashboard, using existing persisted run/event metadata rather than exposing provider secrets.
- Improve timeline readability so `run.started`, provider-backed `agent.message`, and `error` events can be associated with the provider/model/run that produced them.
- Do not add new credential storage, direct dashboard provider calls, or new model-provider execution paths.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `model-provider-integration`: Codex Local provider setup SHALL automatically validate the saved model selection through the backend connection test, and provider/model metadata SHALL remain available for run observability.
- `dashboard-goal-lifecycle`: Goal detail and event timeline SHALL display run provider/model metadata where available so users can distinguish mock, Codex, Claude, and future provider-backed runs.

## Impact

- Dashboard: Provider setup save flow, connection-test state messaging, goal detail metadata rendering, and event timeline metadata rendering.
- Backend/API: Reuse existing `/api/provider-settings/test`; no new credential-bearing endpoint is required. Run/event API responses already include event data, but dashboard parsing/rendering may need tightening.
- Runtime/persistence: No schema migration expected; runs already store `provider` and `model`, and provider-backed `run.started` / `agent.message` events already include metadata. Mock events may need consistent metadata in event data if the UI depends on timeline-only observability.
- Tests: Dashboard/API tests for auto-test after save, connection-test failure display, and provider/model display in goal detail/timeline.
