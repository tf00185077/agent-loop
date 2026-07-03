## Context

auto-agent already has managed runtime sessions, runtime events, approval state, cancellation controls, and a stored child-session request shape. The missing piece is a durable coordinator that turns a provider-neutral delegation request into exactly one backend-managed child session, records what is waiting next, and continues the supervisor when the child result arrives.

Paperclip's execution semantics point to an important boundary: parent/child structure is not enough to represent waiting. auto-agent should therefore model delegation as a first-class durable request/claim with status and result fields, while `agent_sessions.parent` remains relationship metadata.

## Goals / Non-Goals

**Goals:**
- Add a durable delegation core for one active child per supervisor and maximum depth one.
- Keep delegation provider-neutral by validating structured control events before scheduling work.
- Spawn `worker` child sessions through backend-managed runtime APIs.
- Record child success, failure, timeout, cancellation, and detached/ignored outcomes.
- Continue the supervisor after non-detached child results using true resume when available and fresh continuation fallback otherwise.
- Expose basic delegation tree state and child outcomes through backend snapshots and durable events.

**Non-Goals:**
- Review merge, apply/revert, fixed test gating, and workspace checkpoints.
- Parallel children, nested delegation, distributed queues, budget accounting, and multi-user policy.
- Treating parent-child session metadata alone as execution dependency state.
- Requiring MCP or provider-native tools in v1.

## Decisions

1. **Use a durable delegation request/claim.**
   - Decision: persist each accepted delegation request with parent session id, child session id when created, role, status, result summary, and terminal/detached state.
   - Rationale: the backend must be able to answer what moves the supervisor forward without reconstructing provider output or relying on in-memory handles.
   - Alternative considered: store only `agent_sessions.parent`. Rejected because parent metadata is structural and cannot represent waiting, ownership, retries, or detached outcomes.

2. **Keep the state machine narrow.**
   - Decision: model request statuses such as requested, accepted, rejected, running, completed, failed, cancelled, timed_out, detached, and ignored, with explicit transition helpers.
   - Rationale: small durable states are testable and leave future worktree/merge behavior to a later change.
   - Alternative considered: one broad orchestration enum covering merge and worktree phases. Rejected because it couples high-risk workspace side effects to the core continuation loop.

3. **Validate provider-neutral control events before scheduling.**
   - Decision: parse structured delegation control events into a backend-owned request model and reject malformed, unauthorized, duplicate, or nested requests.
   - Rationale: current Codex transport can start with structured output, while the validated request model can later be fed by MCP/tool transports.
   - Alternative considered: Codex-specific command parsing. Rejected because delegation semantics should not depend on one provider's CLI shape.

4. **Use a coordinator service instead of embedding scheduling in event persistence.**
   - Decision: `AgentSessionManager` persists runtime events and delegates accepted child scheduling to a dedicated delegation coordinator.
   - Rationale: event persistence should stay simple; scheduling child sessions and supervisor continuation is a separate runtime concern.
   - Alternative considered: implement child spawn inside `persistRuntimeEvent`. Rejected because it would mix persistence, scheduling, and state transitions in one handler.

5. **Do not fail the supervisor automatically when the child fails.**
   - Decision: child failure, timeout, and cancellation become supervisor observations and may trigger continuation.
   - Rationale: failed delegated work is useful information for supervisor judgment and should not automatically fail the goal.
   - Alternative considered: cascade child failures to parent failure. Rejected because it removes supervisor discretion.

6. **Do not force-cancel children when the supervisor is terminal.**
   - Decision: active children continue; late results are stored as detached or ignored and do not resume the supervisor.
   - Rationale: killing a writing process can leave local state ambiguous, and preserved output is useful for audit.
   - Alternative considered: cascade cancellation. Deferred until safe process cleanup exists.

## Risks / Trade-offs

- [Structured output is brittle] -> Validate a strict schema, reject invalid requests durably, and keep prompts/tool descriptions deterministic.
- [Coordinator introduces concurrency risk] -> Enforce one-active-child and max-depth using repository-level transition methods and tests.
- [Fresh continuation may lose context] -> Include child summaries, event references, and parent session context in the continuation input.
- [Detached children may accumulate stale state] -> Persist detached/ignored results now and leave cleanup/retention policy for a later workspace change.

## Migration Plan

1. Add domain types, persistence fields/tables, and repository transition methods for delegation requests.
2. Add structured control-event parsing and validation.
3. Add coordinator logic for accepted `worker` child spawning and child result handling.
4. Add supervisor continuation after non-detached child outcomes.
5. Add dashboard/API read models and event rendering for basic child state.
6. Roll back by disabling delegation control-event handling; existing single-session behavior remains available.

## Open Questions

- What retention policy should apply to completed child session artifacts before the later worktree cleanup change exists?
- Should timeout be driven by provider adapter timeout, coordinator timeout, or both?
