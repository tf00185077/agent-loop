## Implementation Protocol

- Treat each non-test code-change step as its own commit. Finish the step, run the relevant focused verification, and commit before starting the next code-change step.
- Treat test-only steps at the same `##` level as one batch. Complete all test-only tasks in that section, run that section's tests once through Codex as the agent, and commit the passing test batch together.
- After completing every `##` section, run the full project verification suite once, including typecheck, full tests, relevant browser verification when applicable, and OpenSpec strict validation if the CLI is available. Commit any required fixes before moving to the next section.
- All agent-backed test runs and verification scenarios must use Codex as the agent/provider.
- Do not commit a task or section checkpoint until its required verification passes, unless the commit explicitly documents an unrelated pre-existing failure.

## 1. Observation Contracts

- [x] 1.1 Add domain tests for agent observability event types and safe observation metadata.
- [x] 1.2 Define provider-agnostic observation input types for heartbeat, progress, command lifecycle, and subtask lifecycle.
- [x] 1.3 Extend the model provider progress callback to accept structured observations while keeping a compatibility path for plain output chunks.
- [x] 1.4 Add sanitizer tests for structured observation messages, command summaries, stdout/stderr tails, and JSONL-derived fields.

## 2. Runtime Persistence and Streaming

- [x] 2.1 Add provider-runtime tests proving structured observations are persisted before provider completion.
- [x] 2.2 Map structured observations to durable goal events with provider/model/source/raw-event metadata.
- [x] 2.3 Ensure persisted observation events are published through the existing event bus/SSE stream.
- [x] 2.4 Add tests proving refresh/reconnect snapshots include previously emitted observations in order.
- [x] 2.5 Add tests proving provider runs still succeed when a provider emits no structured observations.

## 3. Codex JSONL Ingestion

- [x] 3.1 Add fixture-driven Codex JSONL parser tests for thread/turn lifecycle, command started, command completed, command failed, agent message, error, and unknown event lines.
- [x] 3.2 Implement an incremental JSONL parser that tolerates partial lines and ignores malformed or unknown events safely.
- [ ] 3.3 Add Codex provider tests proving recognized JSONL events emit structured observations before final response.
- [ ] 3.4 Update Codex provider invocation to prefer `codex exec --json` when supported.
- [ ] 3.5 Preserve final response behavior by using JSONL final agent message or the existing last-message output fallback.
- [ ] 3.6 Add fallback tests for Codex CLI versions where JSONL mode is unavailable or incompatible with last-message output.
- [ ] 3.7 Add tests proving Codex JSONL credential-like material is redacted before persistence and streaming.

## 4. Liveness and Timeout Diagnostics

- [ ] 4.1 Add tests for throttled heartbeat observations during long provider runs with no emitted activity.
- [ ] 4.2 Implement heartbeat emission or last-seen tracking without flooding the durable timeline.
- [ ] 4.3 Add tests proving timeout errors include safe context and preserve prior observations.
- [ ] 4.4 Record a safe no-progress-before-timeout indication when a provider times out without observations.

## 5. Dashboard Timeline Rendering

- [ ] 5.1 Add dashboard state/rendering tests for command, heartbeat, progress, failure, and subtask observation events.
- [ ] 5.2 Render observation event kinds with distinct labels while preserving the existing timeline layout.
- [ ] 5.3 Show provider/model and optional agent/task metadata when present.
- [ ] 5.4 Ensure unknown observation sources and missing future orchestration metadata render without errors.
- [ ] 5.5 Verify the dashboard never displays raw provider payloads when safe summaries are available.

## 6. Future Subagent Integration Seam

- [ ] 6.1 Add tests for optional `agentRole`, `agentId`, `parentAgentId`, and `taskId` metadata round-tripping through persistence and API responses.
- [ ] 6.2 Document how a future main-agent/subagent scheduler should populate observation metadata.
- [ ] 6.3 Keep scheduler creation, subagent process management, and task assignment implementation out of this change.

## 7. Verification

- [ ] 7.1 Run focused domain, provider-runtime, Codex provider, persistence, and dashboard timeline tests.
- [ ] 7.2 Run typecheck and the full test suite, documenting any unrelated pre-existing failures.
- [ ] 7.3 Run browser verification showing a running Codex Local or fixture-backed provider run appends observation events before final completion.
- [ ] 7.4 Run `openspec validate add-agent-observability-event-layer --strict`.
