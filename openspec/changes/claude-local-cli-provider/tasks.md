## 1. Extract the reusable detection core

- [x] 1.1 Create `src/runtime/cli-command-detection.ts` with `detectCliCommand(config, options)` where `config = { commandNames, capabilityCheck, commonPaths }`, porting the PATH → common-location scan, manual-path-first, and capability-gate logic from `codex-cli-detection.ts`
- [x] 1.2 Re-express `detectCodexCliCommand` as a Codex config over the core (command names incl. win variants, `codex exec --help` probe, existing common paths), keeping its public signature and behavior
- [x] 1.3 Add core detection tests, and a regression test asserting Codex resolves the same path/source as before generalization (existing codex-cli-detection tests pass unchanged)

## 2. Generalize self-healing path resolution

- [ ] 2.1 Add generic `resolveCliCommandPath(config, { savedPath, detect?, persist? })` (validate saved path, re-detect stale, persist via callback) and express `resolveCodexCommandPath` over it
- [ ] 2.2 Add tests: valid saved path reused; stale path re-detected + persisted; nothing resolves yields not-found — for a generic config and for Codex

## 3. Add the Claude direct-spawn provider

- [ ] 3.1 Create `src/runtime/claude-cli-provider.ts` implementing `ModelProvider`, spawning `claude --print [--model <label>] --output-format text` with the prompt on stdin and reading the trimmed stdout response
- [ ] 3.2 Select the model argument from the saved label (blank => omit `--model`; concrete => `--model <label>`); map non-zero exit / empty output to a provider error; return `{ text, metadata: { provider: "claude-cli", model }, conversationState: undefined }`
- [ ] 3.3 Add provider tests using an executable fake `claude` binary covering model-arg selection, stdout read, and error mapping

## 4. Add Claude detection config

- [ ] 4.1 Add a Claude detection config (`commandNames: ["claude"]` + win variants, capability probe `claude --help`, common paths including `~/.local/bin`) and a `detectClaudeCliCommand` wrapper over the core
- [ ] 4.2 Add Claude detection tests (PATH hit, `~/.local/bin` fallback, not-found)

## 5. Extend domain settings and persistence

- [ ] 5.1 Add `claude-local` to `LocalProviderKind`, a `ClaudeLocalProviderSettings` type with `claudeCommandPath: string | null`, and extend the `ProviderSettings` union
- [ ] 5.2 Update provider-settings persistence/schema and repository to store and round-trip Claude Local settings (including `claudeCommandPath`)
- [ ] 5.3 Add domain + persistence tests for Claude Local defaults, save, and restart survival

## 6. Wire routes and backend execution

- [ ] 6.1 Extend provider-settings routes to parse/save `claude-local` settings and to detect the Claude CLI on `/detect`
- [ ] 6.2 Wire `app.ts` to select the Claude provider for `claude-local`, resolving (and self-healing) `claudeCommandPath` via `resolveCliCommandPath` before construction; an unresolvable path yields a durable error
- [ ] 6.3 Add API tests: save Claude Local settings, then start a goal end-to-end against a fake `claude` binary (provider `claude-cli`, model-arg behavior, no secret leakage)

## 7. Verify

- [ ] 7.1 Run the full test suite and typecheck; confirm Codex and mock paths are unchanged
- [ ] 7.2 Live smoke: detect the installed `claude` and confirm self-heal of a stale path (no model call required)
- [ ] 7.3 Run `openspec validate claude-local-cli-provider --strict` and confirm the change is clean
