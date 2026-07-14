## Context

The dashboard already receives durable goal, agent-session, delegation,
approval, managed-task, Judge, delivery, and integration state. It also shows a
detailed session/delegation table and event timeline. The missing piece is a
small read model that chooses the most important current activity without
asking users or the browser to interpret those records.

The earlier design proposed reducing events alone. That conflicts with the
current contract runtime: structured SQLite state is authoritative and events
are an audit trail. It also cannot reliably represent cancellation, stale
sessions, candidate-bound re-review, or interrupted integration recovery.

## Goals / Non-Goals

**Goals:**

- Produce one deterministic compact status from durable structured state.
- Distinguish coarse outcome/waiting state from the current pipeline phase.
- Reconstruct the same result after refresh or backend restart.
- Surface bounded sanitized context and exact durable identities when present.
- Fit above the existing detailed controls and timeline without duplicating
  them.

**Non-Goals:**

- Do not create a second scheduler, state store, endpoint family, or SSE model.
- Do not parse free-form LLM prose to decide current authority.
- Do not replace the existing session, delegation, managed-task, integration,
  or event views.
- Do not add elapsed-time stall policy or automatic intervention.
- Do not expose raw prompts, diffs, commands, provider payloads, or credentials.

## Considered Approaches

1. **Events-only reducer — rejected.** It is easy to replay but can disagree
   with current task, delivery, integration, and goal state. Some terminal
   states also lack a dedicated goal event.
2. **Structured records only — rejected.** It gives correct authority but loses
   useful bounded activity summaries and event timestamps.
3. **Layered durable projector — selected.** Structured records select state
   and phase; sanitized events only provide fallback activity text/time. This
   preserves authority and gives the UI useful context.

## Status Contract

`state` is deliberately coarse:

- `running`
- `waiting`
- `stalled`
- `completed`
- `failed`
- `blocked`
- `cancelled`
- `unknown`

`phase` explains where the pipeline is:

- `supervisor`
- `continuation`
- `worker`
- `judge`
- `integrator`
- `rejudge`
- `delivery`
- `validation`
- `rollback`
- `approval`
- `user_input`
- `none`

The view also carries a bounded `summary`, `lastActivityAt`, provider/model, and
nullable `sessionId`, `parentSessionId`, `delegationRequestId`, `role`,
`taskId`, `integrationAttemptId`, and `resolvedCandidateCommitSha`.

## Authority and Precedence

The projector applies this order; the first authoritative match selects the
state/phase while lower layers may only fill missing safe metadata:

1. Terminal goal status (`completed`, `failed`, `blocked`, `cancelled`).
2. Pending approval or explicit user input.
3. Nonterminal or interrupted integration recovery.
4. Active delegation (`worker`, `review_merge`, or `integrator`).
5. Managed task review/delivery state.
6. Current durable session lifecycle, including `stalled`.
7. Latest sanitized durable event as summary/time fallback only.

Candidate-bound integration refines phases as follows:

- `pending` or `resolving` -> `integrator`
- `awaiting_review` -> `rejudge`
- `accepted` -> `delivery`
- `resolution_failed` or `interrupted` -> `stalled` / `integrator`
- terminal `rejected`, `blocked`, or `committed` does not override the task or
  goal state by itself

An active `review_merge` delegation is `rejudge` when linked durable
integration state is awaiting review; otherwise it is `judge`.

## Components and Data Flow

1. A pure `projectAgentLiveStatus` module consumes already-sanitized durable
   goal/session/approval/delegation/managed-task/event inputs.
2. The existing goal agent-session route builds its current snapshot and calls
   the projector once, returning `liveStatus` beside existing fields.
3. Dashboard API types carry the read model unchanged.
4. Goal detail renders a compact panel above detailed managed-session state.
5. Existing durable event notifications continue to trigger snapshot refresh;
   the browser does not independently reduce events.

## Error and Compatibility Behavior

- Historical goals with no sessions return terminal goal state when known,
  otherwise `unknown` / `none`.
- Missing identities or provider metadata remain `null`; rendering does not
  fail.
- Unknown future lifecycle/detail values fall back to `unknown` while retaining
  safe known fields.
- All summaries are whitespace-normalized and capped at 500 characters.
- Structured state always wins when event prose contradicts it.

## Testing Strategy

- Pure projector tests cover every state/phase and each precedence conflict.
- Restart-style tests rebuild inputs from reopened SQLite projections.
- Backend tests prove the existing snapshot includes sanitized live status.
- Dashboard rendering tests cover active roles, partial metadata, stalled, and
  terminal states.
- Full typecheck, tests, strict OpenSpec validation, and diff checks remain the
  completion gate.
