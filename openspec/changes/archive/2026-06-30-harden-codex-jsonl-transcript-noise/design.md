## Context

The Codex Local provider already parses JSONL stdout and converts meaningful observations into durable goal events. The parser currently recognizes a narrow command item shape and treats any unrecognized JSONL event as a visible progress diagnostic. Newer Codex CLI streams emit `item.started` and `item.completed` with nested item types such as `command_execution`, `agent_message`, `reasoning`, `tool_use`, `tool_result`, and `file_change`; successful runs can therefore look suspicious even when no provider failure occurred.

The runtime already has the right durable event model for this focused change: semantic command observations, progress observations, sanitized metadata, and final provider messages. This design keeps that model and improves the Codex adapter's projection from provider JSONL into those existing observations.

## Goals / Non-Goals

**Goals:**

- Recognize current Codex item payloads well enough that successful runs show meaningful command and message progress.
- Stop surfacing harmless unknown `item.*` payloads as alarming user-facing progress.
- Preserve explicit failure visibility for malformed JSONL, `error`, and `turn.failed` events.
- Keep bounded, sanitized summaries for command output tails.

**Non-Goals:**

- Do not add a raw run-log store.
- Do not redesign the dashboard timeline or add a full transcript renderer.
- Do not store full raw Codex JSONL payloads by default.
- Do not change provider settings, model selection, or Codex command invocation behavior.

## Decisions

1. **Extend the existing Codex JSONL parser instead of adding a second transcript pipeline.**
   The current provider-runtime path already persists structured observations and is covered by tests. Extending it keeps this change narrow and avoids introducing Paperclip-style raw log persistence before the product needs it.

2. **Treat `command_execution` as the canonical Codex command item shape while preserving legacy `command`.**
   Existing tests and earlier fake Codex fixtures use `command`, but current Codex streams use `command_execution`. Supporting both avoids regressions and makes the adapter tolerant of CLI version differences.

3. **Map known non-command item types to low-noise observations only when useful.**
   `agent_message` should update progress and final message. `reasoning` can become progress when text exists. Tool/file-change items may produce compact progress summaries, but empty started/completed wrappers should not create noise.

4. **Ignore unknown `item.*` events rather than emitting visible "unrecognized JSONL event" progress.**
   The top-level event was recognized as an item event; the unknown part is the nested item type. Future Codex item types should not make successful runs look broken. Malformed JSONL and unknown top-level non-item events remain diagnostic because they indicate the adapter may be reading a different stream contract.

## Risks / Trade-offs

- **Risk: Ignoring unknown item payloads could hide useful future activity.** → Mitigation: keep known failure events visible and allow future parser tests to add mappings as new item types prove useful.
- **Risk: Command output fields differ across Codex versions.** → Mitigation: read multiple likely fields (`stdout`, `stderr`, `aggregated_output`, `output`) and keep summaries bounded.
- **Risk: Final assistant message might appear in either top-level or nested item events.** → Mitigation: support both and let the last parsed final message remain authoritative, matching current parser behavior.
