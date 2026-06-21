## Context

The Codex Local provider currently runs through two stacked subprocesses: the runtime spawns `node scripts/codex-local-agent-wrapper.mjs`, which speaks an invented `{goal, prompt} -> {text}` JSON-stdio protocol, and the wrapper in turn spawns the Codex CLI (`codex exec --output-last-message <file> -`). The provider adapter `src/runtime/openai-local-agent-provider.ts` is deliberately Codex-agnostic; all Codex knowledge lives in the wrapper.

The product direction is to call each vendor's official CLI directly. Vendor CLIs differ materially in how the prompt is passed, how output is returned, and how sessions resume, so a single universal wrapper protocol relocates per-CLI translation work without eliminating it and adds an extra process. We are collapsing the indirection: one provider per vendor CLI, each spawning its own CLI directly, all behind the single `ModelProvider` contract — the same shape `openai-compatible` already uses for HTTP.

This change is the first step. It refactors Codex onto the direct-spawn pattern, reserves an opaque conversation-state in/out on the contract for later session work, and fixes a latent bug where a stale saved command path is used without re-validation. Streaming and additional vendor CLIs are separate later steps.

## Goals / Non-Goals

**Goals:**
- Replace the generic wrapper path with a Codex-specific provider that spawns the Codex CLI directly.
- Remove `scripts/codex-local-agent-wrapper.mjs`, the `openai-local-agent-provider` adapter, and the `openai-local-agent` config/env contract.
- Add an opaque, provider-owned `conversationState` field to `ModelProviderInput`/`ModelProviderOutput`, passed through by the runtime without interpretation.
- Self-heal the saved Codex command path: validate before use; re-detect and persist when stale.
- Keep behavior otherwise identical: whole (non-streaming) responses, same dashboard endpoints, same saved settings shape.

**Non-Goals:**
- Streaming responses to the dashboard (backend SSE + UI rendering) — deferred.
- Actually continuing a Codex session via `codex exec resume` — the field is reserved but unused this step.
- Additional vendor CLI providers (Claude / Gemini).
- Any change to the dashboard API surface or to persisted provider-settings schema.

## Decisions

### Decision: One Codex provider that spawns the CLI directly
Move the Codex invocation logic (run `codex exec`, choose `--model`, write/read `--output-last-message` temp file, map exit codes to errors) out of the wrapper script and into a `codex-cli-provider` runtime module that implements `ModelProvider`. The provider receives the resolved command path and model label directly.

- **Why over keeping the wrapper**: the per-CLI translation code is unavoidable; inlining it removes one process and one invented protocol, and makes the provider directly unit-testable with a fake `codex` binary (as the existing wrapper tests already do).
- **Alternative considered**: keep the wrapper but make it Codex-only. Rejected — still two processes and a redundant protocol hop for no benefit once we commit to per-vendor providers.

### Decision: Opaque conversation-state on the contract, reserved now
Extend `ModelProviderInput` with an optional `conversationState?: unknown` and `ModelProviderOutput` with an optional `conversationState?: unknown`. The runtime stores/forwards it verbatim and never inspects it. Codex returns `undefined` this step.

- **Why opaque**: session semantics differ per vendor (Codex session file vs. Anthropic message history vs. OpenAI `previous_response_id`). An opaque token lets each provider define its own continuation payload without reshaping the interface later.
- **Why reserve now instead of later**: adding the field later would touch every provider and the runtime call site again; reserving it in this refactor is nearly free and avoids a second breaking pass.
- **Alternative considered**: a structured session type. Rejected as premature — we have no second consumer yet and would over-fit to Codex.

### Decision: Self-heal command path at resolution time
Before constructing/using the Codex provider, check the saved `codexCommandPath` with the same existence + `codex exec --help` capability check used by detection. If it fails, re-run `detectCodexCliCommand`, persist the newly found path into provider settings, and use it. If nothing is found, surface a command-not-found status / durable error rather than spawning a dead path.

- **Why at resolution time**: the failure mode is environmental (CLI upgrade, version-stamped VS Code extension path, reinstall), which happens between saves; validating only at save time cannot catch it.
- **Alternative considered**: switch to invoking bare `codex` by name. Rejected earlier in design discussion — the backend is a spawned process whose PATH is unreliable (GUI/launchd), and an absolute path is verifiable at detect time; self-heal keeps the robustness while fixing staleness.

## Risks / Trade-offs

- [Removing the `openai-local-agent` env contract is breaking for any script relying on `AUTO_AGENT_OPENAI_LOCAL_*`] → These are internal wiring env vars, not a documented public API; the user-facing Codex Local settings (command path, model label) are unchanged, so end users are unaffected. Call it out in the change's BREAKING note.
- [Removing the wrapper and its tests at once leaves a brief window where Codex execution is broken mid-refactor] → The user chose an immediate, single-pass cut; mitigate by landing the new provider and its tests in the same change before deleting the wrapper, and keeping the existing fake-`codex` test approach so coverage does not regress.
- [Self-heal re-detection runs an extra `codex exec --help` spawn on the unhappy path] → Bounded by the existing 5s detection timeout and only triggered when the saved path fails; negligible on the happy path where the saved path validates first.
- [Opaque `conversationState: unknown` weakens type safety at the boundary] → Acceptable and intentional; it is provider-private by design and the runtime only stores/forwards it. Persistence of the value across runs is out of scope here.

## Migration Plan

1. Add `conversationState` to `ModelProviderInput`/`ModelProviderOutput`; update the runtime call site to thread it through (no behavior change since providers return `undefined`).
2. Add the `codex-cli-provider` module (direct spawn) with tests, porting the wrapper's Codex logic and model-argument selection.
3. Add command-path self-heal at provider resolution and persist re-detected paths.
4. Rewire `src/backend/app.ts` Codex Local path to construct the new provider; drop wrapper command/args/env.
5. Remove `openai-local-agent-provider.ts`, the `openai-local-agent` branch in `provider-config.ts`, `scripts/codex-local-agent-wrapper.mjs`, and their tests.
6. Run the full test suite; confirm detect/test/models/start endpoints behave unchanged.

Rollback: revert the change; the prior wrapper path and env contract return intact. No data migration is involved (provider-settings schema is unchanged).

## Open Questions

- None blocking. The shape of the eventual Codex `conversationState` payload (session id vs. rollout path) is intentionally deferred to the session-continuation change.
