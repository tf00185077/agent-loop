## Context

The current vertical slice starts goals through the backend, persists run/step/event state in SQLite, and shows durable events in the dashboard. Runtime behavior is still mock-only, which proves lifecycle observability but not the provider adapter boundary described in the architecture.

This change adds the smallest real-provider path: one provider-backed runtime step that calls an OpenAI-compatible chat completions endpoint and records the response as an event. The dashboard remains unchanged and continues to observe progress only through the backend API and event timeline.

## Goals / Non-Goals

**Goals:**

- Define a small `ModelProvider` contract that runtime code can use without knowing provider-specific HTTP details.
- Add an OpenAI-compatible provider adapter configured from backend environment variables.
- Keep mock behavior available as the default local and automated-test path.
- Add a provider-backed runtime path that creates one step, calls the provider once, records the provider response as `agent.message`, and completes the goal.
- Persist provider failures as `error` events and terminal failed run/goal state.
- Make every implementation slice verifiable without real network access by using fake providers or local fake HTTP servers.

**Non-Goals:**

- Dashboard provider settings or API key input.
- Streaming responses.
- Tool calls, function calling, file access, or command execution.
- Multi-step autonomous planning beyond the single smoke-test step.
- Model discovery, cost tracking, retries, rate limit handling, or advanced observability.
- Multi-agent orchestration, distributed workers, auth, or permissions.

## Decisions

1. **Use a minimal provider contract.**

   Runtime code will depend on a small provider shape, such as `complete(input): Promise<output>`, where input includes goal and prompt context and output includes response text plus provider/model metadata. This keeps the first boundary understandable and easy to fake in tests.

   Alternative considered: introduce a full chat-message abstraction with streaming chunks and tool calls. That would fit future needs but makes the first provider test too wide.

2. **Use OpenAI-compatible chat completions first.**

   The adapter will call `POST {AUTO_AGENT_BASE_URL}/chat/completions` with the configured model and a compact message set derived from the goal. This matches the existing `.env.example` direction and works with OpenAI and many compatible gateways.

   Alternative considered: GitHub Copilot or a local `gh` flow. That adds authentication and product-specific token handling before the provider boundary itself is proven.

3. **Keep provider selection in backend composition.**

   Backend startup will choose mock or OpenAI-compatible behavior from env configuration. The dashboard will not receive or store provider credentials.

   Alternative considered: adding dashboard settings for provider choice. That would add UI and credential-handling scope before the backend contract is validated.

4. **Preserve the mock path as the reliable default.**

   The default provider should remain mock unless env explicitly selects OpenAI-compatible behavior. This keeps local development and CI deterministic.

   Alternative considered: make OpenAI-compatible the default because `.env.example` already names it. That risks failing the local app for users without API keys.

5. **Represent provider-backed execution as one durable step.**

   The provider-backed runtime will create one step, write `step.started`, write an `agent.message` containing the provider response, then write `step.completed`, `run.completed`, and `goal.completed`.

   Alternative considered: ask the model to produce a multi-step plan and execute each step. That is closer to future agent behavior but is not needed to prove the provider line.

6. **Fail visibly through existing event and status concepts.**

   Configuration errors, HTTP errors, and malformed provider responses will create an `error` event, mark the run `failed`, and mark the goal `failed`.

   Alternative considered: leave the goal `running` and only log server errors. That hides the failure from the dashboard timeline and breaks the durable observability model.

## Risks / Trade-offs

- Provider response shape varies across compatible services -> Validate only the minimal chat completions response fields needed for text extraction and treat invalid shapes as provider failures.
- One-step provider execution can look less capable than a real agent -> Name the change as a smoke test and keep full planning/tool use out of scope.
- Env misconfiguration can make the app fail at startup -> Prefer failing the specific run with a durable `error` event when possible, and keep mock as the default path.
- Real provider calls are nondeterministic -> Automated tests use fake providers and local fake HTTP servers; manual real-key testing is documented separately.
- Background runtime errors are currently only logged in the route catch path -> Provider-backed runtime must persist failure state before errors leave the runtime boundary.

## Migration Plan

1. Add provider contract and fake-provider tests without changing dashboard behavior.
2. Add OpenAI-compatible adapter with local fake HTTP tests.
3. Add backend runtime selection from env with mock as default.
4. Add provider-backed runtime happy-path and failure-path tests.
5. Update docs and `.env.example` notes for manual smoke testing.

Rollback is straightforward: set `AUTO_AGENT_PROVIDER=mock` or remove the provider selection change, leaving the existing mock runtime path intact.

## Open Questions

- The first implementation should choose a conservative default model value only if no model is provided, or require `AUTO_AGENT_MODEL` for OpenAI-compatible runs and fail the run visibly when missing.
