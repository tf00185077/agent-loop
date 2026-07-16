# Verification — persist-provider-session-id (Phase 4a)

## Automated tests (real SQLite)

- `src/runtime/agent-session/persist-provider-session-id.test.ts` — 3/3 pass:
  - `updateProviderSessionId` persists the id on the durable session record and
    `getSession` surfaces `providerSessionId`.
  - the manager persists the provider session id observed on a session event's
    `metadata.providerSessionId` (real manager + real SQLite + mock adapter).
  - a session that reports no provider session id leaves it null.
- `src/persistence/database.test.ts` — updated to include the additive
  `provider_session_id` column in the `agent_sessions` schema assertion and the
  positional legacy-insert fixture; all schema/backfill tests pass.
- `npm run typecheck` — clean. `npm test` — 497 pass, 0 fail, 14 skipped.

## Live surface

The manager test above IS the capture-and-persist smoke against real SQLite: a
managed session that emits `providerSessionId` metadata has the id durably
recorded on `agent_sessions`, read back without re-reading provider output. The
column is added via the existing additive `ensureColumn` migration (no table
rebuild; existing rows get null).

## Scope / provider status

- **Codex**: wired — the managed Codex adapter surfaces its JSONL session identity
  (`result.session.sessionId`) as `providerSessionId` metadata on a
  `session.state_changed` event, which the manager persists.
- **Claude**: currently a no-op — the Claude adapter's print-mode runner returns
  plain text and does not expose a session id. Capturing Claude's id requires
  switching that adapter to stream-json parsing; deferred. The manager capture is
  provider-agnostic and will persist Claude's id as soon as the adapter surfaces
  it. This is spec-compliant ("a provider that reports no session id leaves it
  absent").
- Using the persisted id to actually resume (invoke `codex resume` /
  `claude --resume`) is Phase 4b.
