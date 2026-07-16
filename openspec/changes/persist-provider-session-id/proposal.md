## Why

Phase 3b resumes an interrupted goal by starting a fresh session with a
re-projected continuation prompt — the provider-agnostic correctness floor.
Phase 4 adds provider-native transcript resume on top (reasoning continuity), but
that needs the provider's own session id, which the managed supervisor path never
persists. The Codex JSONL parser already extracts a session identity, and both
Codex and Claude CLIs support resume by session id, but the id is not flowed up to
the manager or stored on the durable session row. This change (Phase 4a) durably
captures the provider-native session id so Phase 4b can invoke resume; on its own
it is also useful traceability (correlating an auto-agent session to its provider
rollout).

## What Changes

- Add an optional `providerSessionId` field to `AgentRuntimeEventMetadata`.
- The managed provider adapters (Codex from its JSONL session identity; Claude
  from its stream session id when available) SHALL surface the provider-native
  session id on a session event's metadata.
- The managed session runner persists the provider session id on the durable
  `agent_sessions` row the first time it is observed, via a new
  `provider_session_id` column and a repository update.
- No behavioral change to session execution; this is capture + persistence only.

Non-goals (deferred to Phase 4b):

- Actually **using** the persisted id to resume a session (invoking
  `codex resume` / `claude --resume`). 4a only records the id.
- Any change to the resume-vs-fresh decision in `resumeInterruptedGoal`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-runtime-control-plane`: add a requirement that the managed runtime
  durably records the provider-native session id for a session when the provider
  reports one, so recovery/resume can reference it.

## Impact

- `src/domain/agent-runtime-control-plane.types.ts` — add `providerSessionId` to
  `AgentRuntimeEventMetadata`.
- `src/runtime/providers/codex/codex-runtime-adapter.ts` (+ JSONL mapping) and
  `src/runtime/providers/claude/claude-runtime-adapter.ts` — emit
  `providerSessionId` on a session event.
- `src/runtime/agent-session/agent-session-manager.ts` — persist it when observed.
- `src/persistence/database.ts` (additive `provider_session_id` column) and
  `src/persistence/runtime-repositories.ts` (`updateProviderSessionId` + surface
  it on the session record).
