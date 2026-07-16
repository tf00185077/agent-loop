## 1. Domain + persistence (TDD)

- [x] 1.1 Add `providerSessionId?: string` to `AgentRuntimeEventMetadata` in the domain types.
- [x] 1.2 Write a failing test for a `provider_session_id` column + `updateProviderSessionId(sessionId, providerSessionId)` on the agent session repository, and that the mapped session record surfaces `providerSessionId`.
- [x] 1.3 Add the additive `provider_session_id` column (via `ensureColumn`) and implement `updateProviderSessionId`; surface `providerSessionId` on the session record mapping.

## 2. Manager captures + persists (TDD)

- [x] 2.1 Write a failing test: when a managed session emits an event whose `metadata.providerSessionId` is set, the manager persists it on the durable session row (once), and a session with no such metadata leaves it null.
- [x] 2.2 Wire `runSessionEvents` to persist the first observed `metadata.providerSessionId` via `updateProviderSessionId`, idempotently (skip when already set).

## 3. Adapters surface the id

- [x] 3.1 Map the Codex JSONL session identity onto the `providerSessionId` metadata of a session event in `codex-runtime-adapter` (reuse the parser's extracted session identity).
- [x] 3.2 Surface the Claude stream session id as `providerSessionId` metadata when the Claude adapter observes one (no-op when absent).

## 4. Verify and commit

- [x] 4.1 Run focused tests for the changed files; all green.
- [x] 4.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [x] 4.3 Live smoke per CLAUDE.md: with a mock adapter that emits `providerSessionId` metadata, start a managed session and confirm via the durable session record that the id is persisted. Record findings in this change's `verification.md`.
- [x] 4.4 Commit the task group with an imperative message naming the change (`persist-provider-session-id`).
