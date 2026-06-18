## 1. Provider Settings Persistence

- [x] 1.1 Add provider settings domain/config types for mock and Codex Local selections, including sanitized status fields.
- [x] 1.2 Add SQLite schema and repository support for one local provider settings record with mock defaults.
- [x] 1.3 Add persistence tests proving saved Codex Local settings survive database reopen and default to mock when absent.
- [x] 1.4 Add tests proving persisted settings exclude tokens, API keys, auth cache contents, cookies, and command secret arguments.

## 2. Codex CLI Detection And Connection Testing

- [x] 2.1 Implement Codex CLI command detection using saved manual path, PATH lookup, and common local install locations where practical.
- [x] 2.2 Add detection tests for PATH success, manual path override, and not-found behavior without requiring real Codex network access.
- [x] 2.3 Implement a provider connection test service that invokes the Codex wrapper with a short fixed prompt and returns sanitized status.
- [x] 2.4 Add connection test coverage for success, command-not-found, authentication-needed or unusable-auth, network failure, and generic command failure classification.

## 3. Provider Settings API

- [x] 3.1 Add backend REST endpoints to read provider settings/status, save provider settings, detect Codex CLI, and test Codex Local connection.
- [x] 3.2 Add API tests for reading defaults, saving mock, saving Codex Local with model label and command path, and status after save.
- [x] 3.3 Add API tests proving provider settings/status/test responses do not expose credential material or raw secret-bearing command data.

## 4. Runtime Composition From Saved Settings

- [x] 4.1 Refactor backend runtime selection so goal start uses current saved provider settings instead of only startup environment configuration.
- [x] 4.2 Preserve environment configuration as a development fallback where appropriate without overriding explicit saved settings unexpectedly.
- [x] 4.3 Add API or E2E tests proving a started goal uses saved Codex Local settings through a fake wrapper command without terminal env provider setup.
- [x] 4.4 Add API or E2E tests proving saved mock settings keep mock runtime behavior and do not invoke Codex Local commands.

## 5. Dashboard Provider Setup

- [x] 5.1 Add dashboard API client functions and types for provider settings, detection, and connection test endpoints.
- [x] 5.2 Add provider setup UI for selecting mock or Codex Local, entering or reviewing command path, choosing model label, saving settings, and testing connection.
- [x] 5.3 Add dashboard states for detected, not found, connected, login required, network failure, and command failure.
- [ ] 5.4 Add dashboard tests or browser verification proving settings can be saved and the UI shows connection status without exposing credential material.

## 6. Documentation And Validation

- [ ] 6.1 Document the Codex Local setup flow, including that authentication is managed by Codex CLI and users may need to run `codex login`.
- [ ] 6.2 Run `npm run typecheck`.
- [ ] 6.3 Run `npm test`.
- [ ] 6.4 Run `openspec validate codex-local-provider-settings`.
