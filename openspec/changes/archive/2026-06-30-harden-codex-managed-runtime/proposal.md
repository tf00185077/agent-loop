## Why

Managed delegation depends on Codex being stable enough as the first reference adapter, but the MVP only needs the pieces required to start Codex sessions, capture session identity, resume when possible, and fall back to fresh continuation when resume fails. Paperclip remains a useful reference, but broader runtime polish should not block the first supervised child workflow.

## What Changes

- Keep the Codex provider centered on `codex exec --json -` with prompt content on stdin.
- Capture Codex session identity from JSONL output and persist the minimum session parameters needed for continuation.
- Support true Codex resume when available via `codex exec --json resume <sessionId> -`, with fallback to a fresh continuation prompt when resume is unavailable or unknown.
- Parse the minimum JSONL events needed for MVP control flow: session/thread start, assistant messages, errors, and malformed or unknown diagnostic lines.
- Add adapter capability reporting so the runtime can distinguish true resume support from fresh-continuation fallback.
- Keep missing-command and authentication failures visible through sanitized provider diagnostics.
- Defer managed `CODEX_HOME`, optional search/reasoning/extra-arg support, output inactivity monitoring, usage accounting, and broader Paperclip-style runtime isolation to future work.
- Non-goals for this change: remote sandbox execution, Paperclip organization/project abstractions, full Paperclip API bridge, and making Codex the only supported provider.

## Capabilities

### New Capabilities
- `codex-managed-runtime`: MVP Codex managed runtime behavior for session identity, resumable execution, fallback continuation, minimal JSONL parsing, and diagnostics.

### Modified Capabilities
- `model-provider-integration`: Clarify Codex local provider requirements beyond basic command execution.
- `agent-runtime-control-plane`: Allow the control plane to consume provider capability metadata for true resume versus continuation fallback.

## Impact

- Affects Codex provider invocation, minimal JSONL parser behavior, session metadata persistence, and runtime capability reporting.
- Provides the foundation needed for managed delegation continuations without blocking on full Codex runtime isolation or advanced invocation options.
