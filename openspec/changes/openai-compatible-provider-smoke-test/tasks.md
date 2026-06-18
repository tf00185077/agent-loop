## 1. Provider Contract

- [x] 1.1 Add a small backend-only model provider contract and provider input/output types.
- [x] 1.2 Add unit tests proving runtime code can use an injected fake provider without constructing an HTTP adapter.

## 2. OpenAI-Compatible Adapter

- [x] 2.1 Implement provider configuration loading for `AUTO_AGENT_PROVIDER`, `AUTO_AGENT_BASE_URL`, `AUTO_AGENT_API_KEY`, and `AUTO_AGENT_MODEL` with mock as the default provider.
- [x] 2.2 Implement the OpenAI-compatible chat completions adapter against the provider contract.
- Deferred: Add local fake HTTP tests verifying request URL, authorization header, model payload, and assistant text extraction after the API-key provider path resumes.
- Deferred: Add adapter failure tests for HTTP failures and malformed response bodies after the API-key provider path resumes.

## 3. OpenAI Local Logged-In Agent Provider

- [x] 3.1 Implement openai-local-agent provider configuration loading for the first OpenAI subscription-backed local command.
- [x] 3.2 Implement an openai-local-agent provider that spawns the configured command, sends the goal prompt, and extracts response text.
- [x] 3.3 Add openai-local-agent provider tests with a fake local command verifying prompt input, response extraction, and provider/model metadata.
- [x] 3.4 Add openai-local-agent failure tests for missing command, non-zero exit, timeout, and malformed output.

## 4. Provider-Backed Runtime

- [x] 4.1 Add a provider-backed runtime path that creates a run, creates one step, calls the injected provider once, and writes provider response text as an `agent.message` event.
- [x] 4.2 Add runtime happy-path tests verifying `run.started`, `step.started`, `agent.message`, `step.completed`, `run.completed`, and `goal.completed` events.
- [x] 4.3 Add runtime tests verifying provider and model metadata are persisted in run records or event data.
- [x] 4.4 Add runtime failure tests verifying provider errors create an `error` event and mark the run and goal failed.

## 5. Backend Composition

- [x] 5.1 Update backend app composition to choose mock, openai-local-agent, or OpenAI-compatible behavior from backend environment configuration, with mock as default and openai-local-agent as the first real-provider target.
- [x] 5.2 Add API or E2E tests proving the existing start endpoint can drive a provider-backed run with a fake openai-local-agent provider.
- [x] 5.3 Add API or E2E tests proving missing openai-local-agent configuration fails visibly through events and failed goal status.
- [ ] 5.4 Verify dashboard API responses never include provider secrets or local command credential material.

## 6. Documentation And Validation

- [ ] 6.1 Run `npm run typecheck`.
- [ ] 6.2 Run `npm test`.
- [ ] 6.3 Run `openspec validate openai-compatible-provider-smoke-test`.
