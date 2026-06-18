## Context

The previous provider smoke-test change proved that the backend can run a Codex Local provider through a wrapper around `codex exec`. That path currently works only when the developer starts the backend with the correct shell environment variables, including wrapper arguments and sometimes an absolute Codex CLI path. This is too brittle for a dashboard-driven MVP and will fail across machines when `codex` is not on `PATH`.

The next slice should turn this into a local single-user product workflow. The dashboard should let the user choose Codex Local, detect or enter a Codex CLI path, test whether `codex exec` works with the user's existing Codex-managed authentication, save the non-sensitive settings, and then start goals through the existing API without terminal-only setup.

## Goals / Non-Goals

**Goals:**

- Persist selected provider settings in SQLite so they survive app restarts.
- Let the dashboard choose between mock and Codex Local provider behavior.
- Detect a usable Codex CLI command path, with manual override when auto-detection fails.
- Test Codex Local connectivity by invoking the existing wrapper/Codex CLI path with a minimal prompt.
- Use saved settings when starting goals, without requiring provider environment variables for the Codex Local path.
- Preserve dashboard credential isolation: no provider tokens, API keys, cookies, auth cache contents, or command secret material in dashboard responses.
- Surface actionable status states such as detected, not found, connected, login required, network failure, and command failure.

**Non-Goals:**

- Implement a custom OpenAI OAuth client or handle OpenAI OAuth callbacks in this app.
- Store Codex access tokens, `auth.json`, browser cookies, API keys, or subscription credential material.
- Provide a polished Sign in with Codex button that drives the full interactive login flow.
- Query a live Codex/OpenAI model catalog.
- Add multi-user provider settings or workspace-scoped authorization.
- Replace the existing backend provider contract or provider-backed runtime path.

## Decisions

1. **Use Codex CLI-managed authentication, not app-managed OAuth.**

   The app will not become an OAuth client and will not receive or store OpenAI tokens. Instead, it will check whether the locally installed Codex CLI can run `codex exec` with the user's existing Codex-managed login state. If authentication is missing, the dashboard will show guidance to run `codex login` and then re-check.

   Alternative considered: embed an OpenAI OAuth flow in the dashboard. That would require token handling and product surface assumptions that are outside the current local single-user MVP.

2. **Persist only non-sensitive provider settings.**

   SQLite should store provider choice, Codex command path, model label, last status, last checked timestamp, and sanitized last error. It must not store command secret args, auth files, access tokens, cookies, API keys, or raw stderr that may include sensitive values.

   Alternative considered: store the exact command and args used by the local agent provider. That is flexible but increases the risk of persisting credential-bearing command material.

3. **Keep the wrapper as the command boundary.**

   The existing `scripts/codex-local-agent-wrapper.mjs` remains the adapter between provider input/output JSON and `codex exec`. Saved settings should supply the wrapper with a Codex CLI path through environment, while the backend still invokes the local-agent provider with `node scripts/codex-local-agent-wrapper.mjs`.

   Alternative considered: make the backend invoke `codex exec` directly. Keeping the wrapper preserves the provider contract and lets the local-agent provider continue to operate with any command that follows the same stdin/stdout protocol.

4. **Resolve runtime provider settings at goal start time.**

   Backend app startup should no longer permanently freeze the Codex Local runtime based only on process env. The goal start path should use the current saved provider settings, so changing provider settings in the UI affects the next run without restarting the dev server.

   Alternative considered: keep startup-time composition and require restart after settings changes. That is simpler but does not meet the "no terminal setup" product goal.

5. **Expose status, not secrets.**

   Provider settings/status APIs should return safe fields: selected provider, model label, detected command availability, connection state, and sanitized guidance. They may return the command path if the user saved it as local configuration, but they must not return auth token material, wrapper secret args, API keys, authorization headers, or raw credential file contents.

   Alternative considered: return full diagnostic output for easier debugging. That risks leaking local machine and provider credential details into the dashboard.

## Risks / Trade-offs

- Codex CLI locations vary by platform and install surface -> Use layered detection: explicit saved path, `codex` on PATH, common Windows VS Code extension locations, and a manual path override.
- Login failure messages may vary across Codex versions -> Classify common failures conservatively and fall back to a generic command failure with user guidance.
- Running a real Codex connection test can take time and consume subscription quota -> Use a short fixed prompt and make the test user-initiated.
- Saved local paths are machine-specific -> Treat settings as local app state and allow manual correction.
- Startup-time runtime composition currently assumes env config -> Refactor carefully so tests can inject saved settings without destabilizing the mock default.

## Migration Plan

1. Add provider settings persistence with default mock settings.
2. Add backend detection and connection test services behind API endpoints.
3. Update backend runtime selection to use saved settings for new goal starts.
4. Add dashboard provider setup UI and API client functions.
5. Add API and dashboard tests for detection, save, connection status, and secret isolation.
6. Keep environment variable support as a development fallback and rollback path.

Rollback is straightforward: set the saved provider back to mock or restore environment-driven composition, leaving existing mock and provider runtime paths intact.

## Open Questions

- Should the dashboard display the saved Codex command path by default, or hide it behind an advanced/manual section?
- Should connection tests be run only on demand, or also automatically after saving settings?
- Should the app eventually support multiple named provider profiles, or keep exactly one local active provider setting for the MVP?
