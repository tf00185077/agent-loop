# Proposal: wire-managed-supervisor-end-to-end

## Why

All core pieces for goal-driven delegation already exist — the managed session control plane, the delegation coordinator with worktree isolation, the review-merge gate, and a tested Codex runtime adapter — but they are three disconnected islands. The live server never injects a runtime adapter, no real provider ever emits a `delegationControlEvent`, and the supervisor bootstrap prompt is a placeholder, so a real Codex/Claude goal today runs as a single one-shot `provider.complete()` "smoke step". This change wires the existing pieces into one reachable end-to-end path so a user can state one large goal, and a provider-driven supervisor decomposes it, delegates tasks to child agents, and iterates until the goal is done — AI-to-AI instead of human-interactive.

## What Changes

- Wire the Codex runtime adapter into the live server by default: starting a `codex-local` goal runs a managed supervisor session (no `createApp` option injection required); the one-shot provider-runtime path remains only as an explicit fallback when managed capability detection fails.
- Teach the Codex JSONL parsing path to recognize fenced structured control blocks (`managed_delegation.request`, `managed_delegation.complete`) in assistant output and surface them as `delegationControlEvent` / completion metadata on runtime events.
- Replace the placeholder supervisor prompt with a supervisor orchestration prompt contract: goal understanding, task decomposition into an explicit task list, per-task worker delegation, review-merge delegation after worker results, continuation instructions, and the exact control-block output format.
- Allow a supervisor session to run multiple sequential delegations over its lifetime (still exactly one active child at a time, depth one), so a decomposed goal with N tasks can be delivered task by task.
- Require an explicit supervisor completion signal: a managed goal completes when the supervisor emits a completion control block (or terminal session success with completion evidence), not merely when a provider process exits.
- Add a Claude runtime adapter implementing the same `AgentRuntimeAdapter` contract (fresh-continuation fallback; no true resume required for v1) so provider choice is not Codex-only.
- Invoke the existing-but-dead `CompletionGate` in the agent loop before finishing a goal, so the mock/loop path and the managed path share the same "AI decides done" semantics.
- Emit the durable orchestration events (task list recorded, task started/completed, delegation lifecycle, continuation, completion) that the pending `add-agent-live-status-model` change will later reduce into live status; that change stays separate and unblocked.

## Capabilities

### New Capabilities

- `supervisor-goal-orchestration`: How a managed supervisor session turns one large user goal into an executed result — bootstrap prompt contract, task decomposition and durable task list, sequential per-task worker delegation, review-merge invocation, iterate-until-done, and explicit completion signaling.

### Modified Capabilities

- `codex-managed-runtime`: The Codex adapter/parser SHALL detect structured delegation control blocks (`managed_delegation.request`, `managed_delegation.complete`) in assistant output and emit them as delegation/completion control metadata instead of plain progress text.
- `managed-delegation-core`: A supervisor SHALL be able to issue multiple sequential delegation requests over its lifetime (one active at a time unchanged); goal completion for managed sessions SHALL require an explicit supervisor completion signal.
- `model-provider-integration`: Managed sessions become the default (not test-injected) execution path for interactive local providers constructed from saved provider settings; a Claude managed runtime adapter SHALL exist with capability detection and fresh-continuation behavior.

### Spec-Conformance Gaps Closed (no spec change)

The existing `iterative-agent-loop` spec already requires completion-gate voting before completion and enqueueing `DECOMPOSE` sub-steps; the current implementation does neither (`gate` is a dead dependency; `DECOMPOSE` only re-plans). The existing `agent-runtime-control-plane` spec already defines tool-shaped delegation control events and delegation lifecycle states — no delta needed there. These are implementation tasks, not spec changes.

## Impact

- **Backend**: `src/backend/app.ts` runtime selection (`selectRuntimeForSettings`) constructs runtime adapters from saved provider settings; `server.ts` unchanged in shape.
- **Runtime**: `src/runtime/providers/codex/` (JSONL parser + runtime adapter control-block extraction), new `src/runtime/providers/claude/claude-runtime-adapter.ts`, `src/runtime/agent-session/` (supervisor prompt builder, completion signal handling, sequential delegation), `src/runtime/agent-loop/agent-loop-runtime.ts` (completion gate invocation).
- **Domain**: control-plane types gain the completion control event and task-list metadata shapes.
- **Persistence**: agent session repository may need per-supervisor task list / delegation sequence fields (additive migration).
- **Dashboard**: no new UI required by this change; existing timeline renders the new events. Live status rendering remains in `add-agent-live-status-model`.
- **Docs**: README "Direction" section updated — it currently references a change (`add-managed-delegation-continuations`) that was never created.

## Non-Goals

- Parallel children, nested delegation (depth > 1), or a multi-agent run tree UI.
- Distributed workers, queues, or multi-user auth.
- True MCP/tool transport for delegation (control blocks remain the v1 transport).
- Claude true-resume support (fresh continuation only in v1).
- Rich stalled detection / live status reduction (stays in `add-agent-live-status-model`).
