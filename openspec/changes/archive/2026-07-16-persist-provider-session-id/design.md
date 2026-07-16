## Context

The Codex JSONL parser already extracts a `CodexJsonlSessionIdentity` (sessionId)
from session/thread start events, but the managed `codex-runtime-adapter` does not
surface it and the manager never persists it. `AgentRuntimeEventMetadata` has no
field for it. There is no `provider_session_id` column on `agent_sessions`. Both
Codex (`codex resume <id>`) and Claude (`claude -p --resume <id>`) support resume
by this id; Phase 4b will use it. This change only captures + persists it.

## Goals / Non-Goals

**Goals:** durably record the provider-native session id on the session row,
captured from event metadata, with zero execution-behavior change.

**Non-Goals:** invoking resume (Phase 4b); any resume decision logic.

## Decisions

**1. Carry the id on event metadata, persist at the manager.** Add
`providerSessionId?: string` to `AgentRuntimeEventMetadata`. The Codex adapter maps
its parsed JSONL session identity onto the metadata of a session event (e.g. the
`session.started` event); the Claude adapter does the same from its stream session
id when present. The managed session runner (`runSessionEvents`) watches for the
first event whose `metadata.providerSessionId` is set and calls a repository
update. Rationale: keeps the provider adapters pure (emit metadata) and the
backend owner of persistence, matching the control-plane rules. Alternative
rejected: adapters writing to the DB directly — violates the side-effect boundary.

**2. Additive column, idempotent write.** Add `provider_session_id TEXT` to
`agent_sessions` (additive migration via the existing `ensureColumn` helper; no
table rebuild). Add `updateProviderSessionId(sessionId, providerSessionId)` and
surface `providerSessionId` on the mapped session record. The manager only writes
it once (when currently null / unchanged), so repeated session events are cheap
no-ops.

**3. Best-effort and optional.** A provider that never reports a session id leaves
the column null; nothing downstream requires it in 4a. Capturing it must never
affect session execution.

## Risks / Trade-offs

- [Provider emits multiple/ changing session ids] → Record the first observed id;
  ignore later ones (a managed session is one provider session). Revisit only if a
  provider legitimately rotates ids mid-session.
- [Sensitive data in the id] → Session ids are opaque provider identifiers, not
  credentials; they are stored as-is like other durable session metadata and are
  not surfaced in credential-sanitized paths beyond the existing session record.

## Migration Plan

Additive column via `ensureColumn`; existing rows get a null provider session id.
No data backfill. Rollback drops the capture wiring; the column is harmless if
left.

## Open Questions

- Should the id also appear in the sanitized session snapshot the dashboard reads?
  Deferred: not needed for 4b; add later if the UI wants to show the provider
  rollout link.
