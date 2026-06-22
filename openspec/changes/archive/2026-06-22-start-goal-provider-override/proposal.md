## Why

The provider setup model selector currently only affects future runs after the user presses Save, which makes it easy to start a goal with stale provider/model settings. Starting a goal should use the provider and model currently selected in the dashboard, while saved provider settings remain a default rather than the only execution source.

## What Changes

- Extend the start-goal action to accept a per-run provider override from the dashboard.
- Send the currently selected provider/model/command-path state when the user starts a goal, without requiring Save.
- Prefer the start request override over saved provider settings for that run.
- Keep saved provider settings as persisted defaults used to initialize the provider setup UI and as fallback when no override is supplied.
- Record run/event metadata from the actual provider/model used for the run.
- Sanitize override command paths using the same credential-safe rules as saved provider settings.

## Capabilities

### New Capabilities

### Modified Capabilities
- `dashboard-goal-lifecycle`: Changes the start-goal interaction so the selected provider/model state can be sent with the start action.
- `model-provider-integration`: Changes provider-backed runtime selection to support per-run provider overrides in addition to saved defaults.

## Impact

- Affects the start-goal API contract, dashboard provider setup/start wiring, runtime selection, provider settings sanitization, and tests.
- Does not remove saved provider settings or the Save action.
- Does not add credential storage, multi-user settings, or provider secrets to dashboard responses.
