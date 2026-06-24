## 1. Event Stream Contract

- [x] 1.1 Add backend tests for a goal-scoped live event stream endpoint.
- [x] 1.2 Implement the SSE endpoint with initial connection handling and terminal cleanup.
- [x] 1.3 Ensure live stream payloads use the same event shape as the durable events endpoint.

## 2. Event Publication

- [x] 2.1 Add an internal event publisher that emits after durable event creation.
- [x] 2.2 Wire goal event persistence through the publisher without bypassing SQLite.
- [x] 2.3 Add tests for reconnect-safe snapshot plus streamed event deduplication assumptions.

## 3. Provider Process Output

- [x] 3.1 Add provider-runtime tests for persisting sanitized progress events from provider output chunks.
- [x] 3.2 Extend provider contract or runtime dependencies to accept progress callbacks.
- [x] 3.3 Capture and sanitize Claude CLI stdout/stderr chunks as progress events while preserving final result behavior.
- [x] 3.4 Investigate Codex CLI process output with the current `codex exec --output-last-message` invocation and implement safe chunk capture where useful output is available.
- [x] 3.5 Add provider tests proving secret-like process output is redacted before persistence and streaming.

## 4. Dashboard Live Timeline

- [x] 4.1 Add dashboard tests for EventSource-based timeline updates without polling.
- [ ] 4.2 Load the durable snapshot before opening the live stream.
- [x] 4.3 Append streamed events by event id and ignore duplicates.
- [ ] 4.4 Close or stop relying on the stream when the goal reaches a terminal state.

## 5. Verification

- [ ] 5.1 Run focused backend stream, provider runtime, CLI provider, and dashboard timeline tests.
- [ ] 5.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 5.3 Run browser verification that a running goal timeline receives pushed events without manual refresh.
- [ ] 5.4 Run `openspec validate stream-agent-process-events --strict`.
