## Why

Codex Local provider setup currently relies on a free-form model label and a stale default value, which can produce connection failures even when the Codex CLI path and login are valid. Users need the dashboard to discover the local Codex model catalog and save a supported model without guessing internal slugs.

## What Changes

- Add a backend provider-settings model catalog endpoint that invokes the configured Codex CLI with `debug models` and returns a sanitized list of selectable models.
- Change Codex Local provider setup from a plain model-label text box to a model picker backed by the catalog, while preserving manual model entry when catalog lookup fails or a desired model is not listed.
- Save the selected model slug as the Codex Local model label and pass it to the wrapper when a specific model is selected.
- Replace the stale hard-coded `gpt-5-codex-subscription` fallback with a catalog-first default; when no model is selected or catalog lookup fails, allow Codex CLI to use its own default model.
- Keep credential material, raw model prompt metadata, and hidden/non-list catalog entries out of dashboard API responses.

## Capabilities

### New Capabilities

### Modified Capabilities
- `model-provider-integration`: Codex Local provider setup SHALL expose a sanitized model catalog and support selecting a valid local Codex model with fallback to manual/default behavior.

## Impact

- Backend REST API under `/api/provider-settings`.
- Runtime service code for invoking Codex CLI catalog discovery.
- Provider settings domain/API types for model catalog entries and model fallback semantics.
- Dashboard API client and `ProviderSetup` UI.
- Tests for catalog parsing, API sanitization, dashboard model picker behavior, and wrapper model argument behavior.
- Documentation for selecting models and using Codex CLI defaults.
