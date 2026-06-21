## Why

The Codex Local provider currently runs through a generic JSON-stdio wrapper (`scripts/codex-local-agent-wrapper.mjs`) driven by a provider implementation (`openai-local-agent-provider`) that knows nothing about Codex. This indirection adds an extra Node process and an invented protocol that buys portability we do not want: the chosen product direction is to call each vendor's official CLI directly, and those CLIs differ enough (how the prompt goes in, how output comes back, how sessions resume) that a single universal wrapper protocol fights reality rather than simplifying it. Separately, the resolved Codex command path is persisted once and never re-validated, so a CLI upgrade or reinstall leaves a stale path that fails until the user manually re-detects.

## What Changes

- Introduce a Codex-specific provider that spawns the Codex CLI directly, replacing the generic wrapper indirection. The provider owns Codex's invocation details (`codex exec`, model argument selection, reading the last-message output).
- **BREAKING**: Remove the generic `openai-local-agent` wrapper path — both `scripts/codex-local-agent-wrapper.mjs` and the `openai-local-agent-provider` runtime adapter, plus their `AUTO_AGENT_OPENAI_LOCAL_*` / `AUTO_AGENT_CODEX_COMMAND_*` wrapper env contract.
- Extend the `ModelProvider` contract with an opaque, provider-owned `conversationState` in/out so future session continuation can be threaded without re-shaping the interface. This step reserves the in/out only; Codex does not yet resume a session.
- Self-heal the persisted Codex command path: before using a saved path, verify it still resolves and re-run detection (updating saved settings) when it does not, instead of spawning a stale path.
- Keep responses whole (non-streaming) in this change. Token streaming to the dashboard and additional vendor CLIs are explicitly deferred to follow-up changes.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `model-provider-integration`: The backend provider contract gains an opaque `conversationState` in/out. The "OpenAI local logged-in agent provider" requirement is replaced by a Codex-specific direct-spawn provider (no generic wrapper). The Codex command-path requirement adds self-healing re-detection of a stale saved path.

## Impact

- Runtime: replace `src/runtime/openai-local-agent-provider.ts` with a Codex direct-spawn provider; extend `src/runtime/model-provider.ts` (`ModelProviderInput`/`ModelProviderOutput`) with opaque `conversationState`; update `src/runtime/provider-config.ts` to drop the `openai-local-agent` config shape.
- Scripts: delete `scripts/codex-local-agent-wrapper.mjs` and its tests.
- Backend: `src/backend/app.ts` provider wiring no longer passes wrapper command/args/env; add command-path self-heal at provider construction / detection.
- Tests: remove wrapper-protocol tests; add direct-spawn provider tests and self-heal tests.
- Non-goal (deferred): streaming pipeline (backend SSE + dashboard rendering), Codex `exec resume` session continuation, and additional vendor CLI providers (Claude / Gemini).
- Dashboard contract is unchanged: it still calls the existing start/detect/test/models endpoints; only backend-internal provider mechanics change.
