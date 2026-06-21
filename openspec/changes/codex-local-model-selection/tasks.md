## 1. Model Catalog Contract

- [x] 1.1 Add domain/API types for sanitized Codex Local model catalog entries, catalog status, and default-model semantics.
- [x] 1.2 Implement a runtime service that invokes Codex CLI `debug models`, parses JSON output, filters selectable visible models, orders by priority, and maps only safe fields.
- [x] 1.3 Add runtime tests for successful catalog parsing, hidden model filtering, priority ordering, malformed JSON, command failure, and credential/raw metadata sanitization.

## 2. Backend API

- [x] 2.1 Add `GET /api/provider-settings/models` to return sanitized model catalog results using the saved or detected Codex CLI command path.
- [x] 2.2 Add API tests proving catalog results include selectable model slugs and omit base instructions, prompt metadata, hidden models, tokens, cookies, and secret-bearing command data.
- [x] 2.3 Add API tests proving catalog lookup failures return a sanitized fallback response that still permits manual/default model setup.

## 3. Wrapper And Runtime Defaults

- [x] 3.1 Update Codex Local connection testing and goal execution so blank model selection means Codex CLI default and does not pass `--model`.
- [x] 3.2 Preserve compatibility for existing saved `gpt-5-codex-subscription` settings by not forcing that legacy label as a Codex CLI model.
- [x] 3.3 Add tests proving selected catalog model slugs are passed to Codex CLI and blank or legacy labels are omitted from wrapper model arguments.
- [x] 3.4 Ensure provider-backed runtime metadata remains understandable when Codex CLI default model behavior is used.

## 4. Dashboard Model Picker

- [x] 4.1 Add dashboard API client types/functions for loading Codex Local model catalog results.
- [x] 4.2 Replace the Codex Local model text input with a model picker populated from catalog results, ordered by priority.
- [ ] 4.3 Preserve manual model entry and Codex CLI default behavior when catalog lookup fails or the user chooses an unlisted model.
- [ ] 4.4 Add loading, empty, and failure states for model catalog lookup without exposing raw CLI output.
- [ ] 4.5 Add dashboard tests proving catalog models render, selection saves the model slug, manual/default fallback remains available, and raw metadata is not displayed.

## 5. Documentation And Verification

- [ ] 5.1 Document Codex Local model selection, catalog refresh, manual fallback, and Codex CLI default behavior in README.
- [ ] 5.2 Run `npm run typecheck`.
- [ ] 5.3 Run `npm test`.
- [ ] 5.4 Run `openspec validate codex-local-model-selection`.
