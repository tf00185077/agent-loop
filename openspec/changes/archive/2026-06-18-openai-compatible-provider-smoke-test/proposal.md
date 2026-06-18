## Why

The first vertical slice proves the goal lifecycle with a mock runtime, but it does not yet prove that the runtime can call a real model provider through a backend-only boundary. This change started by adding the smallest OpenAI-compatible provider path needed to validate live model integration without expanding into full autonomous agent behavior.

The immediate smoke-test priority is now to validate backend-spawned agent execution through a local OpenAI subscription-backed agent process before continuing API-key integration work. The API provider path remains a supported provider option, but it is not the first runtime path to wire end-to-end.

## What Changes

- Add a backend model provider contract that the runtime can call without depending on a specific provider implementation.
- Add provider implementations behind the same backend model provider contract, starting with an OpenAI subscription-backed local agent runner and keeping the OpenAI-compatible API adapter as an alternate path.
- Keep the mock provider/runtime path available for local development and automated tests.
- Add a provider-backed runtime path that performs one minimal model-backed step, persists the model response as an `agent.message` event, and completes the goal.
- Add failure handling that records an `error` event and marks the run and goal failed when provider configuration or provider calls fail.
- Add a local logged-in agent runner path that lets the backend spawn a local agent process using the user's existing OpenAI subscription-backed login state.
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
- Adds a local logged-in agent runner path that becomes the first end-to-end provider-backed runtime target.
- Keeps `.env.example` and documentation ready for both openai-local-agent and API-key provider smoke paths.
