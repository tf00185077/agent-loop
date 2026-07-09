# Design: wire-managed-supervisor-end-to-end

## Context

The delegation control plane (`agent-session-manager`, `delegation-coordinator`, worktree isolation, review-merge gate) and the Codex runtime adapter are implemented and tested, but unreachable in the live server:

- `server.ts` calls `createApp(db)` without `agentRuntimeAdapters`, so `selectRuntimeForSettings` always falls through to the one-shot `createProviderRuntime` path for `codex-local`/`claude-local`.
- No provider adapter ever emits `delegationControlEvent` metadata — the Codex JSONL parser turns assistant output into plain progress text, so a real supervisor has no way to request a child.
- The managed-session bootstrap prompt is the placeholder `"Run this goal through the managed local agent runtime."` — it never tells the model how to decompose a goal or emit control blocks.
- The agent loop's `CompletionGate` is a required dependency that is never invoked, and `DECOMPOSE` never enqueues sub-steps — both violate the existing `iterative-agent-loop` spec.

The user-facing target: state one large goal once, then a provider-driven supervisor decomposes it, delegates tasks to isolated child agents, review-merges results, and iterates until done — with no human in the loop.

## Goals / Non-Goals

**Goals:**

- Make the managed supervisor path the default, reachable execution path for `codex-local` (and `claude-local`) goals started from the dashboard.
- Define one delegation control-block wire format that any CLI provider can emit in plain assistant text.
- Give the supervisor a bootstrap prompt contract that produces decomposition, sequential delegation, review-merge, and explicit completion.
- Support N sequential tasks per goal (multiple delegations per supervisor lifetime).
- Add a Claude runtime adapter so the orchestration is not Codex-only.
- Bring the agent loop implementation into conformance with its existing spec (gate invocation, sub-step queue).

**Non-Goals:**

- Parallel children, nesting beyond depth one, multi-agent tree UI.
- MCP/tool transport (control blocks stay the v1 transport).
- Claude true resume (fresh continuation only).
- Live status reduction/rendering (stays in `add-agent-live-status-model`).
- Distributed execution, auth, billing.

## Decisions

### 1. Control-block wire format: fenced JSON in assistant text

Supervisor output signals intent with a fenced block the parser can extract deterministically:

````text
```auto-agent-control
{"type": "managed_delegation.request", "role": "worker",
 "taskId": "task-2", "summary": "Implement lobby matchmaking",
 "prompt": "<full worker prompt>"}
```
````

- `type` ∈ {`managed_delegation.request`, `managed_delegation.complete`}.
- The fence tag `auto-agent-control` is unambiguous to grep out of mixed prose and cheap for models to produce reliably; JSON body reuses the existing `validateDelegationControlEvent` schema (extended with optional `taskId`).
- Extraction happens in the runtime adapter layer (Codex: on `agent_message` items; Claude: on stdout text), which attaches the parsed object as `metadata.delegationControlEvent` on the runtime event — exactly what `agent-session-manager` already consumes. **Alternative considered**: teaching the JSONL parser itself about control blocks — rejected because the parser should stay a pure Codex-JSONL translator; control-block semantics are provider-neutral and belong one layer up in a shared `extractControlBlocks(text)` utility used by both adapters.
- Text before/after the block still flows as normal sanitized progress. A message containing a control block is not shown verbatim (the block is stripped from the progress message).

### 2. Explicit completion signal, not process exit

Today `session.completed` (process exit) marks the goal completed. With a multi-task supervisor, a process exit is usually just "this turn ended". New rule:

- A managed goal completes only when the supervisor emits `managed_delegation.complete` (with a result summary), or the session terminally fails/cancels.
- When a supervisor session exits **without** a completion or pending delegation, the control plane starts a continuation ("You have not signalled completion; continue or complete.") up to a configured `maxSupervisorContinuations` bound (default ~10) — the backstop against a model that never signals.
- On reaching the bound, the goal is marked `blocked` with a durable reason, mirroring the loop's existing bounded semantics. **Alternative considered**: keep exit-means-done — rejected; it is exactly the current one-shot behavior that prevents iteration.

### 3. Supervisor bootstrap prompt is a versioned builder, not a string

`buildSupervisorPrompt(goal, opts)` in `src/runtime/agent-session/` produces:

1. Role framing (you are a supervisor; you do not edit files yourself).
2. The goal title/description.
3. Instructions: decompose into an ordered task list first; announce it in plain text (durably recorded as an `agent.progress` event with `taskList` metadata); delegate exactly one `worker` task at a time; after each worker result decide re-delegate / next task / review_merge; run `review_merge` referencing the worker delegation request id before declaring done.
4. The exact control-block format with one example per type, and the rule that only fenced `auto-agent-control` blocks are honored.
5. Continuation variant: same contract plus the child observation ("Worker result: …") — replacing today's bare `Worker result: ${observation}` message so fresh continuations retain the contract. This matters because Claude v1 has no resume: every continuation must re-carry the full contract.

### 4. Server constructs adapters from saved settings (no injection)

`selectRuntimeForSettings` gains a default: for `codex-local`, build `createCodexRuntimeAdapter` from the same resolved command path / model label used today by the one-shot path; likewise `claude-local` once its adapter exists. The `agentRuntimeAdapters` option remains for tests (mock adapters) and as an override. Fallback: if adapter capability detection fails (e.g. Codex CLI too old for JSONL session mode), record a durable downgrade event and use the existing one-shot provider runtime — visible, not silent.

### 5. Claude runtime adapter: minimal contract, fresh continuation

`createClaudeRuntimeAdapter` wraps `claude --print` (non-interactive) per session turn: capabilities `{resume: false, events: stdout-progress, approval: false, cancel: kill}`. Each continuation is a fresh spawn with the rebuilt contract prompt. This deliberately reuses the existing fresh-continuation branch in `continueSupervisorAfterChild` — no new control-plane code path. True resume (`--resume`) is deferred.

### 6. Task list is durable metadata, not a new table

The announced task list and per-task progress ride on existing durable events (`agent.progress` with `taskList` / `taskId` metadata) plus the existing delegation-request rows (extended with nullable `taskId`). **Alternative considered**: a first-class `tasks-per-goal` table — rejected for v1; the event timeline plus delegation requests already reconstruct state, and `add-agent-live-status-model` reduces from events by design. Only additive migration: `task_id` column on delegation requests.

### 7. Agent-loop conformance fixes ride along, scoped to the mock path

Invoke `gate.vote()` after each implemented step (majority `done` → complete; otherwise continue within bounds) and turn `DECOMPOSE` sub-steps into a work queue consumed in order. This keeps the mock demo path honest with its spec and gives the dashboard a deterministic multi-step fixture. It does not attempt to merge the loop with the managed path — the managed supervisor *is* the planner for real providers.

## Risks / Trade-offs

- [Models emit malformed control blocks] → Parser rejects with a durable `delegation.rejected` + safe reason; the continuation prompt includes the rejection reason so the supervisor can retry with corrected format. Bounded by `maxSupervisorContinuations`.
- [Supervisor never signals completion; burns tokens] → Continuation bound (Decision 2) terminates as `blocked`; each continuation is durably visible in the timeline.
- [Codex/Claude CLI versions differ in output modes] → Capability detection with a recorded, visible downgrade to one-shot mode (Decision 4).
- [Control block leaks into user-visible progress text] → Adapter strips blocks from progress messages before sanitization; tests assert no fenced block reaches durable event messages.
- [Sequential-only tasks are slow for large goals] → Accepted for v1; parallel children are an explicit non-goal and the README already stages them post-MVP.
- [Prompt contract drift between start and continuation] → Single `buildSupervisorPrompt` builder with variants, unit-tested for the required sections.

## Migration Plan

1. Land shared control-block extraction + validation (pure functions, heavily tested).
2. Land supervisor prompt builder + completion-signal/continuation-bound handling in the control plane (mock adapter tests drive the full loop: decompose → 2 workers → review_merge → complete).
3. Wire Codex adapter construction into `selectRuntimeForSettings`; extend the Codex adapter to attach control metadata.
4. Add Claude runtime adapter behind the same selection logic.
5. Agent-loop gate/queue conformance fixes.
6. Docs: README direction section (remove the never-created `add-managed-delegation-continuations` reference), demo path for a real managed goal.

Rollback: the one-shot provider runtime remains intact; removing adapter construction from `selectRuntimeForSettings` restores current behavior. SQLite change is one additive nullable column.

## Open Questions

- Should `review_merge` be mandatory before completion when any worker changed files, or advisory (supervisor decides)? Default in this design: prompt instructs it strongly, control plane does not hard-enforce; can tighten later.
- `maxSupervisorContinuations` default (proposed 10) and whether it should be provider-settings-configurable from the dashboard in v1.
- Whether the completion control block should carry structured acceptance evidence (tests run, files touched) in v1 or just a safe summary.
