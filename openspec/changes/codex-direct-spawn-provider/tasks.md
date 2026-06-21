## 1. Extend the provider contract with opaque conversation state

- [x] 1.1 Add optional `conversationState?: unknown` to `ModelProviderInput` and `ModelProviderOutput` in `src/runtime/model-provider.ts`
- [x] 1.2 Update the runtime provider call site (`src/runtime/provider-runtime.ts`) to forward an incoming `conversationState` into the input and carry the returned `conversationState` through without inspecting it
- [x] 1.3 Add a runtime test proving the runtime forwards `conversationState` verbatim and tolerates its absence

## 2. Add the Codex direct-spawn provider

- [x] 2.1 Create `src/runtime/codex-cli-provider.ts` implementing `ModelProvider`, spawning the resolved Codex command with `codex exec --skip-git-repo-check --output-last-message <tmp> -` and the prompt on stdin
- [x] 2.2 Port model-argument selection (blank / `gpt-5-codex-subscription` / `mock-v1` => omit `--model`; concrete label => `--model <label>`) into the provider, replacing the wrapper's `resolveModelArgument`
- [x] 2.3 Read the last-message temp file, map non-zero exit / empty output to a provider error, and return `{ text, metadata, conversationState: undefined }`
- [x] 2.4 Add provider tests using a fake `codex` binary (mirror the existing wrapper tests) covering default-model omission, concrete `--model`, and error mapping

## 3. Self-heal the saved Codex command path

- [x] 3.1 Add a `resolveCodexCommandPath` helper that validates the saved path (existence + `codex exec --help` capability) and, on failure, re-runs `detectCodexCliCommand`
- [x] 3.2 When re-detection finds a new path, persist it into provider settings; when nothing resolves, surface a command-not-found status / durable error instead of spawning
- [x] 3.3 Add tests: valid saved path is used unchanged; stale path triggers re-detect + persist; no path resolves fails visibly

## 4. Rewire the backend to the new provider

- [x] 4.1 Update `src/backend/app.ts` Codex Local wiring to construct `codex-cli-provider` from the resolved (self-healed) command path and model label, dropping `codexLocalWrapperCommand`/`Args`/`Timeout` and the `AUTO_AGENT_CODEX_COMMAND_PATH` / `AUTO_AGENT_OPENAI_LOCAL_*` env handoff
- [x] 4.2 Confirm detect / test / models endpoints use the same resolution path and still return unchanged shapes (routes resolve via `detect({ manualPath })`, the same detection `resolveCodexCommandPath` wraps; shapes unchanged, route tests green)

## 5. Remove the wrapper indirection

- [x] 5.1 Delete `scripts/codex-local-agent-wrapper.mjs` and `src/runtime/codex-local-agent-wrapper.test.ts`
- [x] 5.2 Delete `src/runtime/openai-local-agent-provider.ts` and its test, and remove the `openai-local-agent` branch + config type from `src/runtime/provider-config.ts`
- [x] 5.3 Remove now-dead `AUTO_AGENT_OPENAI_LOCAL_*` references and update any remaining wiring/types (also repointed the Codex Local connection test to the direct-spawn provider)

## 6. Verify

- [ ] 6.1 Run the full test suite and typecheck; fix regressions
- [ ] 6.2 Manually exercise a Codex Local goal end-to-end (detect, test, start) confirming whole-response behavior is unchanged
- [ ] 6.3 Run `openspec validate codex-direct-spawn-provider` and confirm the change is clean
