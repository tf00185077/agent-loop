## 1. Start Override Contract

- [ ] 1.1 Add domain/API types for provider-agnostic start-goal provider overrides.
- [ ] 1.2 Add backend API tests for start with Codex Local, mock, and absent override.
- [ ] 1.3 Sanitize override command paths using the provider settings safety rules.

## 2. Runtime Selection

- [ ] 2.1 Update start-goal route parsing to accept an optional override body.
- [ ] 2.2 Prefer the override over saved provider settings when selecting the runtime for that run.
- [ ] 2.3 Preserve saved-settings fallback when no override is supplied.
- [ ] 2.4 Ensure run/event metadata reflects the actual override provider/model used.

## 3. Dashboard Start Wiring

- [ ] 3.1 Lift or expose current provider setup state so goal start can read the selected provider/model.
- [ ] 3.2 Send the current provider override in `startGoal` without calling Save.
- [ ] 3.3 Keep Save as the only action that persists provider defaults.
- [ ] 3.4 Update dashboard tests for unsaved selected model used on start and saved settings remaining unchanged.

## 4. Provider Compatibility

- [ ] 4.1 Cover Codex Local override with selected catalog model and command path.
- [ ] 4.2 Cover Claude Local override with model label and command path.
- [ ] 4.3 Cover mock override even when saved settings point to a local provider.
- [ ] 4.4 Confirm credential material is not exposed in start responses or event metadata.

## 5. Verification

- [ ] 5.1 Run focused provider settings, backend API, runtime selection, and dashboard provider setup tests.
- [ ] 5.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 5.3 Run browser verification that selecting a model and pressing Start without Save uses that model for the new run.
- [ ] 5.4 Run `openspec validate start-goal-provider-override --strict`.
