## 1. Provider Setup Auto-Test

- [x] 1.1 Update the provider setup save flow so saving Codex Local settings triggers the existing backend connection test after the save succeeds
- [ ] 1.2 Show distinct save/test busy states and render the sanitized auto-test result without hiding manual Test connection retry
- [ ] 1.3 Ensure mock and Claude Local saves do not trigger Codex Local connection tests
- [ ] 1.4 Add dashboard/API tests covering auto-test success, auto-test failure, and no auto-test for non-Codex providers

## 2. Run Metadata Recording

- [ ] 2.1 Ensure mock runtime run-level events include displayable provider/model metadata
- [ ] 2.2 Ensure provider-backed error events include displayable provider/model metadata when the runtime knows it
- [ ] 2.3 Add runtime/persistence tests proving run/event metadata stays non-sensitive and usable for display

## 3. Dashboard Run Metadata Display

- [ ] 3.1 Add dashboard-side helpers to derive latest provider/model metadata from a goal's event timeline
- [ ] 3.2 Show latest available provider/model metadata in goal detail
- [ ] 3.3 Show provider/model metadata near timeline events that carry it, while tolerating historical events without metadata
- [ ] 3.4 Add dashboard rendering tests for latest run metadata, per-event metadata, and missing metadata

## 4. Verification

- [ ] 4.1 Run typecheck and focused tests for provider setup, runtime metadata, and dashboard timeline rendering
- [ ] 4.2 Run browser E2E with Codex Local save auto-test and verify the selected model status is visible
- [ ] 4.3 Run `openspec validate provider-connection-test-and-run-model-visibility --strict`
