## Context

After the `codex-direct-spawn-provider` change, the backend has one CLI-type provider. Its building blocks — `codex-cli-detection.ts` (PATH → common-location search with a `codex exec --help` capability probe) and `codex-command-path.ts` (`resolveCodexCommandPath`: validate saved path, self-heal stale, persist) — are written specifically for Codex. API-type providers (`openai-compatible`) do not spawn anything and are unaffected.

We now add Claude Code (`claude`) as a second subscription-backed local CLI. Probing the installed CLI (v2.1.169) established its real contract:

- Non-interactive: `claude -p/--print [prompt]` (prompt as positional arg or stdin).
- Output: `--output-format text` (default) | `json` | `stream-json`. Text prints the whole response to stdout.
- Model: `--model <model>`.
- Sessions: `--resume <id>`, `--session-id <uuid>`, `--continue`; `--output-format json` returns a `session_id`.
- Installed at `~/.local/bin/claude` (a different common location than Codex's nvm path).

The two CLIs differ in every invocation dimension (prompt in, output out, non-interactive flag, install location), confirming that the right abstraction is a shared detection/resolution core plus a thin per-CLI provider and detection config — not a universal wrapper protocol.

## Goals / Non-Goals

**Goals:**
- Extract a reusable `detectCliCommand({ commandNames, capabilityCheck, commonPaths })` and `resolveCliCommandPath`, with Codex expressed as a config over them and its behavior unchanged.
- Add `claude-cli-provider` that spawns `claude --print` and returns the whole stdout response; `conversationState: undefined`.
- Add `claude-local` provider settings (enum, type with `claudeCommandPath`, persistence, PUT/detect routes) and backend wiring with self-heal.

**Non-Goals:**
- Claude `/test` connection check and `/models` catalog UI.
- Claude session continuation (`--resume` / capturing `session_id`).
- Streaming.
- Any change to Codex behavior/settings or the `ModelProvider` contract.

## Decisions

### Decision: Shared detection core, per-CLI config
Create `cli-command-detection.ts` exposing `detectCliCommand(config, options)` where `config = { commandNames, capabilityCheck, commonPaths }`. Re-express `detectCodexCliCommand` as a Codex config (`commandNames: ["codex"]` / win variants, `capabilityCheck: codex exec --help`, the existing common paths) calling the core. Add a Claude config (`commandNames: ["claude"]`, `capabilityCheck: claude --help`, common paths incl. `~/.local/bin`). Likewise generalize `resolveCodexCommandPath` → `resolveCliCommandPath(config, { savedPath, persist })`.

- **Why now**: with a real second CLI we can see which parts are common (PATH/common-location scan, capability gate, manual-path-first, self-heal) vs per-CLI (binary names, probe command, install locations). Extracting earlier would have guessed the seam.
- **Why preserve Codex via config (not rewrite)**: keeps the prior change's behavior and tests green; the generalization is a refactor, not a behavior change. A "Codex detection behavior is preserved" scenario guards this.
- **Alternative considered**: leave Codex code as-is and copy it for Claude. Rejected — two near-identical copies is exactly the duplication this change exists to avoid.

### Decision: Claude provider uses `--output-format text` and stdout
`claude -p <prompt> [--model <m>] --output-format text`, prompt passed on stdin (mirrors the provider's existing stdin handling and avoids arg-escaping/quoting issues), response read from stdout and trimmed. Non-zero exit / empty output map to a provider error. Returns `conversationState: undefined`.

- **Why text not json**: session is deferred (decision below), so the `session_id` that `json` carries is not needed yet; text is the simplest correct path and matches Codex's whole-response behavior.
- **Why stdin for the prompt**: avoids shell-quoting a possibly large/multiline goal prompt as a positional arg; `claude --print` accepts stdin.

### Decision: Defer session, return undefined conversationState
Claude provides session continuation, but we return `conversationState: undefined` for now, symmetric with Codex. The reserved opaque field means wiring Claude's `session_id` later (switch to `--output-format json`, capture `session_id`, pass `--resume`) needs no interface change.

- **Alternative considered**: wire `session_id` now. Rejected to keep this change focused and the two CLI providers behaviorally aligned.

### Decision: Separate `claudeCommandPath`, additive settings
`ClaudeLocalProviderSettings` carries its own `claudeCommandPath: string | null`; `LocalProviderKind` and the `ProviderSettings` union gain `claude-local`. Codex's `codexCommandPath` is untouched.

- **Why a separate field, not a generic `commandPath` rename**: renaming the persisted column touches the DB schema, repository, routes, and dashboard, and risks regressing Codex for no functional gain. A separate additive field is lower-blast-radius. The shared abstraction lives in the runtime detection/resolution code, which is what this change is really about.
- **Alternative considered**: one generic `commandPath` column. Rejected for blast radius; can be revisited if a third CLI makes the per-field approach unwieldy.

## Risks / Trade-offs

- [Generalizing Codex detection could subtly change its resolution] → Keep Codex's command names, probe, and common paths byte-for-byte in its config; add a regression scenario/test asserting Codex still resolves as before.
- [`claude --help` as a capability probe is weaker than Codex's `codex exec --help`] → It still confirms an executable Claude binary; richer validation (a real `--print` round-trip) belongs to the deferred `/test` connection check.
- [Persisting a Claude path under nvm-style or version-stamped locations could go stale] → Same self-heal mechanism as Codex (`resolveCliCommandPath`) covers it; `~/.local/bin/claude` is comparatively stable.
- [Subscription auth secrets leaking] → The provider never reads or forwards auth material; reuse the existing security scenarios/tests asserting dashboard responses and events contain no credential/session secrets.

## Migration Plan

1. Add `cli-command-detection.ts` (generic core) and generic `resolveCliCommandPath`; re-express Codex detection/resolution as configs over them; keep Codex tests green.
2. Add `claude-cli-provider.ts` with a fake-`claude` test (model arg selection, stdout read, error mapping).
3. Extend domain settings (`claude-local`, `ClaudeLocalProviderSettings`, `claudeCommandPath`) and persistence.
4. Extend provider-settings routes to save/detect `claude-local`; wire `app.ts` to construct the Claude provider via `resolveCliCommandPath`.
5. Run the full suite + typecheck; confirm Codex and mock paths are unchanged.

Rollback: revert the change; Codex/mock unaffected. Additive settings field means no destructive schema migration.

## Open Questions

- None blocking. Claude session payload shape (session_id vs rollout) is intentionally deferred to a later session-continuation change, reusing the opaque `conversationState`.
