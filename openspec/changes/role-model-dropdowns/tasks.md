## 1. Role model dropdown + hide command path (TDD)

- [ ] 1.1 Write failing tests (ProviderSetup.test.tsx) that: a `codex-local` role renders a model `<select>` populated from the catalog models (with a "Provider default" option); a `claude-local` role renders a model `<select>` with the curated aliases `opus`/`sonnet`/`haiku`; neither renders a command-path input; selecting a model updates the role assignment's model label; the persisted command path stays null.
- [ ] 1.2 Thread `catalogModels` (and availability state) from `ProviderSetupPanel` into `RoleAssignmentsEditor` props.
- [ ] 1.3 Replace the role model `<input>` with a provider-appropriate `<select>` (Codex catalog with text-input fallback when unavailable; curated Claude aliases), and remove the command-path `<input>` (keep `commandPath: null`); optionally show a saved-but-unlisted model as a "(saved)" option for parity with the main picker.

## 2. Verify and commit

- [ ] 2.1 Run focused dashboard tests (`ProviderSetup.test.tsx`); all green.
- [ ] 2.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [ ] 2.3 Live smoke: run the dashboard (or render the panel) and confirm a Codex role shows the catalog dropdown, a Claude role shows opus/sonnet/haiku, and no command-path field appears. Record findings in this change's `verification.md`.
- [ ] 2.4 Commit the task group with an imperative message naming the change (`role-model-dropdowns`).
