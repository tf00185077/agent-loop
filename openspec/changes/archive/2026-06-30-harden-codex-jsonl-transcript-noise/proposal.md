## Why

Codex CLI now emits JSONL events such as `item.started` and `item.completed` with nested item types that auto-agent does not fully recognize, causing successful runs to show alarming "unrecognized JSONL event" progress entries. Users need quiet, meaningful run tracking that highlights command execution and final messages while keeping low-value or future Codex item types from polluting the main timeline.

## What Changes

- Teach the Codex JSONL parser to understand Codex `item` payloads modeled after the current CLI stream, including `command_execution`, `agent_message`, `reasoning`, `tool_use`, `tool_result`, `file_change`, and `error`.
- Preserve semantic command lifecycle events for command execution start/completion/failure, including bounded sanitized output tails.
- Extract final assistant text from `item.completed` agent-message payloads when present.
- Downgrade unknown `item.*` payloads so they do not appear as scary user-facing "unrecognized JSONL event" progress during otherwise successful runs.
- Keep malformed JSONL, provider errors, and turn failures visible as diagnostics or failures.
- Non-goal: introduce a Paperclip-style raw run-log store or redesign the dashboard transcript renderer in this change.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `model-provider-integration`: Codex Local JSONL parsing should recognize current Codex item payloads and preserve final-result behavior without surfacing successful unknown item payloads as alarming progress.
- `agent-observability-events`: Provider JSONL observations should remain durable and credential-safe while distinguishing meaningful user-facing observations from low-value diagnostics.

## Impact

- Affected runtime code: `src/runtime/providers/codex/codex-jsonl-parser.ts` and Codex provider tests.
- Affected observability behavior: fewer noisy `agent.progress` entries for harmless Codex item events, more semantic `agent.command.*` events for `command_execution`.
- No new dependencies, storage tables, dashboard routes, or credential surfaces.
