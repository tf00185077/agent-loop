## 1. Provider Contract

- [ ] 1.1 Add a small backend-only model provider contract and provider input/output types.
- [ ] 1.2 Add unit tests proving runtime code can use an injected fake provider without constructing an HTTP adapter.

## 2. OpenAI-Compatible Adapter

- [ ] 2.1 Implement provider configuration loading for `AUTO_AGENT_PROVIDER`, `AUTO_AGENT_BASE_URL`, `AUTO_AGENT_API_KEY`, and `AUTO_AGENT_MODEL` with mock as the default provider.
- [ ] 2.2 Implement the OpenAI-compatible chat completions adapter against the provider contract.
- [ ] 2.3 Add local fake HTTP tests verifying request URL, authorization header, model payload, and assistant text extraction.
- [ ] 2.4 Add adapter failure tests for HTTP failures and malformed response bodies.

## 3. Provider-Backed Runtime

- [ ] 3.1 Add a provider-backed runtime path that creates a run, creates one step, calls the injected provider once, and writes provider response text as an `agent.message` event.
- [ ] 3.2 Add runtime happy-path tests verifying `run.started`, `step.started`, `agent.message`, `step.completed`, `run.completed`, and `goal.completed` events.
- [ ] 3.3 Add runtime tests verifying provider and model metadata are persisted in run records or event data.
- [ ] 3.4 Add runtime failure tests verifying provider errors create an `error` event and mark the run and goal failed.

## 4. Backend Composition

- [ ] 4.1 Update backend app composition to choose mock or OpenAI-compatible runtime behavior from backend environment configuration.
- [ ] 4.2 Add API or E2E tests proving the existing start endpoint can drive a provider-backed run with a fake provider.
- [ ] 4.3 Add API or E2E tests proving missing OpenAI-compatible configuration fails visibly through events and failed goal status.
- [ ] 4.4 Verify dashboard API responses never include provider secrets.

## 5. Documentation And Validation

- [ ] 5.1 Update `.env.example` and README with the manual OpenAI-compatible smoke-test path.
- [ ] 5.2 Run `npm run typecheck`.
- [ ] 5.3 Run `npm test`.
- [ ] 5.4 Run `openspec validate openai-compatible-provider-smoke-test`.
