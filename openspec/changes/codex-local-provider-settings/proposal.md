## Why

The Codex local provider path is proven, but using it still requires manually setting wrapper and environment variables in a terminal before starting the app. This change makes Codex Local usable as a product workflow by letting a local single-user dashboard detect, test, save, and use Codex provider settings without repeated shell setup.

## What Changes

- Add backend provider settings persistence for the selected provider, Codex CLI command path, model label, and non-sensitive status metadata.
- Add backend APIs for reading provider settings, saving provider settings, detecting a Codex CLI command, and testing the Codex Local connection through the existing wrapper path.
- Add dashboard UI for selecting `mock` or `codex-local`, viewing detected Codex status, entering a manual command path when needed, choosing a model label, saving settings, and testing the connection.
- Update backend runtime composition so starting a goal can use saved provider settings instead of requiring `AUTO_AGENT_*` shell environment variables for the Codex Local path.
- Preserve the mock provider as the default and fallback local development path.
- Do not implement a custom OpenAI OAuth client or store OpenAI/Codex tokens. The MVP relies on Codex CLI-managed authentication and only checks whether `codex exec` can run.
- Do not expose local command credential material, access tokens, cookies, API keys, or command arguments through dashboard APIs.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `model-provider-integration`: Adds provider settings persistence, Codex CLI path detection, Codex Local connection testing, and dashboard-driven provider selection without terminal-only environment setup.

## Impact

- Affects SQLite schema with a small provider settings table or equivalent durable settings storage.
- Affects backend composition so provider runtime selection can read saved settings at goal start time.
- Adds backend provider settings/status/test REST endpoints.
- Adds dashboard provider setup UI and API client functions.
- Extends Codex Local wrapper/config behavior while keeping provider secrets behind the backend boundary.
- Adds API, persistence, runtime composition, and dashboard tests around saved provider settings and Codex connection status.
