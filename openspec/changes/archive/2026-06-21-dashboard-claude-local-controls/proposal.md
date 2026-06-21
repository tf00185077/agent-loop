## Why

The backend supports the `claude-local` provider, but the dashboard provider setup only exposed Mock and Codex Local — a user could not select Claude Local from the screen, only by calling the API directly. This change documents the dashboard controls that make `claude-local` selectable, matching the deferred-UI scope (no model catalog or connection test for Claude yet), and a model-label reset so switching providers does not carry a stale label across.

## What Changes

- Add a third provider segment (Claude Local) to dashboard provider setup, with a free-text model label input, a command path input, and a Detect control.
- Claude Local intentionally omits the model catalog picker and the connection test control (both deferred for Claude).
- Make the provider setup status wording CLI-aware so Claude Local shows Claude wording rather than Codex wording.
- Reset the model label when the selected provider changes so a previous provider's label (e.g. `mock-v1`) does not leak onto another provider; restore the saved label when switching back to the saved provider.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `model-provider-integration`: The dashboard provider setup controls requirement gains Claude Local selection (without catalog/connection-test controls) and a model-label reset on provider switch.

## Impact

- Dashboard: `src/dashboard/ProviderSetup.tsx` (third segment, Claude section, CLI-aware status, model-label reset) and `src/dashboard/api.ts` (claude-local in `ProviderSettings` / `SaveProviderSettingsInput`).
- Tests: `src/dashboard/ProviderSetup.test.tsx` covers the Claude Local controls.
- No backend changes (the `claude-local` backend already exists); no change to the saved settings schema.
