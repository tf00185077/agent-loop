# Tasks: wire-managed-supervisor-end-to-end

## 1. Control-Block Wire Format (provider-neutral)

- [x] 1.1 Add domain types for the completion control event (`managed_delegation.complete` with safe result summary) and optional `taskId` on delegation control events.
- [x] 1.2 Add tests for a shared `extractControlBlocks(text)` utility: fenced `auto-agent-control` blocks are extracted, prose is preserved, blocks are stripped from progress text, malformed JSON yields a typed rejection.
- [x] 1.3 Implement `extractControlBlocks` in `src/runtime/agent-session/` (or a shared runtime util) as pure functions.
- [x] 1.4 Extend `validateDelegationControlEvent` tests and implementation to accept optional `taskId` and validate `managed_delegation.complete` payloads.

## 2. Supervisor Prompt Contract

- [x] 2.1 Add tests for `buildSupervisorPrompt(goal)` asserting required sections: role framing, goal context, decomposition-first instruction, one-worker-at-a-time rule, review-merge instruction, exact control-block format examples for both types.
- [x] 2.2 Implement the supervisor prompt builder with bootstrap and continuation variants (continuation carries child observation or "continue or complete" nudge plus full contract).
- [x] 2.3 Replace the placeholder prompt in the managed-session start path and the bare `Worker result: …` continuation message with the builder outputs.

## 3. Sequential Delegation + Explicit Completion (control plane)

- [x] 3.1 Add agent-session-manager tests: supervisor completes only on a valid completion control block; process exit without completion and without pending delegation starts a bounded continuation; bound exhaustion marks the goal blocked with a durable reason.
- [x] 3.2 Implement completion-signal handling and the `maxSupervisorContinuations` bound (config via `CreateAppOptions`, default 10).
- [x] 3.3 Add tests for multiple sequential delegations in one supervisor lifetime: worker A completes → supervisor continues → worker B accepted; one-active-child rejection still holds while a child runs.
- [x] 3.4 Implement sequential delegation support and persist `taskId` on delegation requests (additive nullable SQLite column + repository support).
- [x] 3.5 Add tests and implementation for durable task-list recording: supervisor task-list announcement persists an event with `taskList` metadata; delegation lifecycle events carry `taskId` when present.
- [x] 3.6 Add a mock-adapter end-to-end control-plane test: bootstrap → task list → worker 1 → continuation → worker 2 → review_merge → completion block → goal completed, all reconstructable from durable events.

## 4. Codex Adapter Wiring

- [x] 4.1 Add codex-runtime-adapter tests: `agent_message` items containing fenced control blocks emit events with `delegationControlEvent` / completion metadata and stripped progress text; prose-only messages behave unchanged.
- [x] 4.2 Implement control-block extraction in the Codex runtime adapter using the shared utility.
- [x] 4.3 Add app-level tests: starting a `codex-local` goal with saved settings (no injected adapter) constructs the Codex runtime adapter and starts a managed session; injected adapters still take precedence.
- [x] 4.4 Implement default Codex adapter construction in `selectRuntimeForSettings` from resolved command path and model label.
- [x] 4.5 Add tests and implementation for the visible downgrade path: when adapter capability detection reports managed mode unsupported, record a durable downgrade event and run the one-shot provider path.

## 5. Claude Runtime Adapter

- [ ] 5.1 Add tests for `createClaudeRuntimeAdapter`: session start spawns Claude CLI in print mode with the prompt, progress and terminal events are emitted, capabilities report `resume: false`, cancel terminates the process, startup failure emits a sanitized terminal failure.
- [ ] 5.2 Implement the Claude runtime adapter in `src/runtime/providers/claude/claude-runtime-adapter.ts`, including control-block extraction from stdout text.
- [ ] 5.3 Wire `claude-local` into default adapter construction in `selectRuntimeForSettings` with the same downgrade fallback, and verify fresh-continuation supervisor flow with a Claude-shaped fake adapter.

## 6. Agent-Loop Spec Conformance (mock path)

- [ ] 6.1 Add agent-loop tests: completion gate is invoked after each implemented step; `not_done` majority continues the loop within bounds; `done` majority completes; each vote is recorded durably.
- [ ] 6.2 Implement gate invocation in `agent-loop-runtime.ts` and remove the unconditional finish-after-first-step behavior.
- [ ] 6.3 Add tests and implementation for `DECOMPOSE` sub-step queueing: sub-steps are enqueued and consumed in order instead of only re-planning.
- [ ] 6.4 Update mock runtime defaults/tests so the deterministic demo path still terminates predictably.

## 7. Docs + Verification

- [ ] 7.1 Update README: replace the stale `add-managed-delegation-continuations` reference, document the managed supervisor demo path (big goal → decompose → workers → review-merge → complete) and the downgrade/fallback behavior.
- [ ] 7.2 Run a manual end-to-end smoke with a real Codex Local goal that requires at least two tasks; capture the durable timeline as evidence.
- [ ] 7.3 Run typecheck and the full test suite; document any unrelated pre-existing failures.
- [ ] 7.4 Run `openspec validate wire-managed-supervisor-end-to-end --strict`.
