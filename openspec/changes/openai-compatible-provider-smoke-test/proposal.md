## Why

The first vertical slice proves the goal lifecycle with a mock runtime, but it does not yet prove that the runtime can call a real model provider through a backend-only boundary. This change adds the smallest OpenAI-compatible provider path needed to validate live model integration without expanding into full autonomous agent behavior.

## What Changes

- Add a backend model provider contract that the runtime can call without depending on a specific provider implementation.
- Add an OpenAI-compatible chat completions adapter configured only through backend environment variables.
- Keep the mock provider/runtime path available for local development and automated tests.
- Add a provider-backed runtime path that performs one minimal model-backed step, persists the model response as an `agent.message` event, and completes the goal.
- Add failure handling that records an `error` event and marks the run and goal failed when provider configuration or provider calls fail.
- Document the manual smoke path for testing with a real OpenAI-compatible provider.
- Do not add dashboard provider settings, streaming, tool calls, multi-step planning, cost tracking, retries, or multi-agent orchestration in this change.

## Capabilities

### New Capabilities

- `model-provider-integration`: Covers backend-only provider configuration, OpenAI-compatible adapter behavior, provider-backed runtime events, and provider failure handling.

### Modified Capabilities

- None.

## Impact

- Affects backend composition where the runtime is created from environment configuration.
- Affects runtime code by adding a provider-backed execution path alongside the existing mock path.
- Adds provider adapter code under the backend/runtime boundary.
- Adds tests using fake providers and local fake HTTP responses so automated verification does not require network access or API keys.
- Updates `.env.example` and documentation for the provider smoke path if needed.
