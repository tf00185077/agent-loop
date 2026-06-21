## Why

The backend now has exactly one CLI-type provider (Codex direct-spawn), and its detection, self-heal, and spawn logic are written specifically for Codex. Adding a second subscription-backed local CLI — Claude Code (`claude`) — is the moment to extract the shared "detect → self-heal → spawn an authenticated local CLI" pattern into a reusable mechanism, so each vendor CLI is a thin provider plus a small detection config rather than a copy of the Codex code. Claude Code is already installed and logged in on target machines, so users who prefer their Claude subscription can run goals without an API key, the same way Codex Local works.

## What Changes

- Generalize Codex's detection into a reusable `detectCliCommand({ commandNames, capabilityCheck, commonPaths })`, and generalize `resolveCodexCommandPath` into `resolveCliCommandPath` (validate saved path, self-heal a stale one, persist the re-detected path). Codex keeps its current behavior by supplying a Codex-specific config.
- Add a `claude-cli-provider` that spawns the Claude Code CLI directly: `claude -p <prompt> [--model <model>] --output-format text`, reading the whole response from stdout. It returns `conversationState: undefined` (session continuation deferred, symmetric with Codex).
- Add a `claude-local` provider option to provider settings: provider enum value, settings type, persistence, and the PUT / detect routes. A separate `claudeCommandPath` holds the resolved Claude command path.
- Wire `claude-local` goal execution in the backend: resolve (and self-heal) the Claude command path, then construct the Claude provider behind the existing `ModelProvider` contract.
- Claude detection config: binary name `claude`, capability probe `claude --help`, common install locations including `~/.local/bin`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `model-provider-integration`: Add a Claude Code direct-spawn provider (subscription-backed local CLI) alongside Codex, and generalize CLI command detection + self-healing path resolution so they are shared across CLI-type providers rather than Codex-specific.

## Impact

- Runtime: new `src/runtime/cli-command-detection.ts` (generic `detectCliCommand`) and generic `resolveCliCommandPath`; `codex-cli-detection.ts` and `codex-command-path.ts` become thin Codex configs over the generic core (Codex behavior preserved). New `src/runtime/claude-cli-provider.ts`.
- Domain: `LocalProviderKind` gains `claude-local`; new `ClaudeLocalProviderSettings` with `claudeCommandPath`; `ProviderSettings` union extended.
- Persistence: provider-settings repository/schema stores the Claude command path for `claude-local`.
- Backend: `app.ts` selects the Claude provider for `claude-local`; provider-settings routes accept and detect `claude-local`.
- Tests: generic detection/resolution tests; Claude provider tests with a fake `claude` binary; settings persistence + route tests for `claude-local`.
- Non-goals (deferred): Claude `/test` connection check and `/models` catalog UI; Claude session continuation (`--resume`, capturing `session_id`); streaming. Codex behavior, settings, and the existing `ModelProvider` contract are unchanged.
- Security: Claude uses its existing logged-in subscription auth (`claude login`); no API key is required and authentication/session secrets must not appear in dashboard responses or durable events.
