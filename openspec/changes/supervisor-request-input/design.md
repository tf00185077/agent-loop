## Context

`caller-escalation-contract` shipped the goal-level escalation machinery: durable
`goal_input_requests`, `waiting_user`, deterministic response validation, resume via
`resumeGoalFromDurableProjection`, API routes, and the dashboard panel. It is
backend-initiated only. This change adds the supervisor-initiated entry point while
touching as little as possible: one new control-block type in, the same contract out.

Anchors in current code:

- Control blocks: `managedControlEventTypes` union
  (agent-runtime-control-plane.types.ts ~353), shape validation in
  `delegation-control-event.ts` (`validateManagedControlEvent`), handling branches in
  `agent-session-manager.ts` keyed by `validation.kind`.
- Escalation: `escalateGoalForCallerInput` (manager) already records the request +
  event + `waiting_user`; the `startCompletionlessContinuation` guard already skips
  `waiting_user` goals, so a session that emitted a question and then exited does not
  spawn a continuation.
- Respond flow: `respondToGoalInputRequest` validates against
  `payload.allowedDecisions`; `provide_guidance` resumes with an observation.

## Goals / Non-Goals

**Goals:**

- A live supervisor can ask exactly one bounded question and receive the answer as a
  continuation observation, with every gate enforced by backend validators.
- Zero new API surface, response kinds, or dashboard components.
- Question requests never interact with budget grants.

**Non-Goals:**

- Multi-turn clarification while waiting; child-agent questions; free-form caller→AI
  chat. Timeouts/auto-answers are out of scope (waiting is indefinite, as today).

## Decisions

**D1 — Reuse `provide_guidance` as the answer decision.** A question's allowed
decisions are `["provide_guidance", "abandon"]`. The caller's answer travels as the
existing guidance string through the existing validation, events, API, and dashboard
textarea. Alternative (new `answer` decision) rejected: it would ripple through the
response union, API clients, and panel for zero semantic gain.

**D2 — `supervisor_question` is a new reason code, not a new request kind.**
`GoalInputRequestReason` gains `supervisor_question`; `allowedDecisionsForReason`
returns guidance+abandon for it. The question text is stored as the request's
`safeSummary` (sanitized), supervisor-supplied context strings as `payload.evidence`.
The dashboard already renders summary + evidence + allowed decisions, so it needs only
a reason label.

**D3 — Payload budget fields become nullable.** `budgetName`/`budgetValue` are
`null` for question requests (a question exhausts nothing); the respond flow and the
accepted-response event skip effective-budget computation when null. Alternative
(carry the continuation budget as context) rejected as misleading.

**D4 — Implicit grants get an explicit allowlist.** `sumAcceptedExtensions` currently
grants +1 for any accepted guidance except the circuit breaker; with questions in the
mix that heuristic is wrong. New rule: implicit +1 applies only to
`epoch_budget_exhausted` and `continuation_exhausted`. This is a behavior fix inside
the existing capability, covered by a delta spec.

**D5 — Acceptance gates, all deterministic, all with teaching rejections** (via the
existing `recordControlRejection`, which feeds the next continuation prompt):

1. Goal has no pending input request (single-pending invariant).
2. The emitting session has no in-flight delegation (`requested`/`accepted`/
   `running`) — child outcomes must come home before the supervisor may block on a
   human.
3. Question non-empty after trim, ≤ 2000 chars; ≤ 5 evidence strings, each ≤ 500
   chars (bounded like other control-plane text).
4. Per-goal question budget: count of prior `supervisor_question` requests (any
   status, from durable rows) < `maxSupervisorQuestions` (deps option, default 3).
   Exhaustion rejects with "decide autonomously using your best judgment and
   proceed" — the loop must not stall on infinite asking.

**D6 — Accepted block ends the turn.** The handler escalates (request + durable
`goal.input_requested` event with `runtimeEventType: "supervisor.question"` +
`waiting_user`) and returns; when the session then exits, the existing
`waiting_user` guard suppresses the continuation. No new session-lifecycle states.

**D7 — Observation carries both sides.** Resume observation for a question renders
`Caller answered the supervisor's question. Q: <question> A: <answer>` so the fresh
continuation is self-contained without event-timeline archaeology.
`renderCallerObservation` gains the request as input.

**Boundaries**: control-block extraction stays provider-pure in the adapters;
validation shape lives in `delegation-control-event.ts`; all side effects in the
manager; SQLite owns the request; dashboard talks only to existing endpoints.

## Risks / Trade-offs

- [Supervisor asks instead of working] → Question budget (D5.4) plus prompt contract
  language scoping questions to decisions the caller alone can make; rejections teach
  autonomy.
- [Question arrives while a child is running] → Gate 2 rejects it; the supervisor is
  told to wait for the child observation first.
- [Existing dashboards/agent clients see a null budgetName] → Nullable fields are
  additive JSON; the shipped panel reads only summary/evidence/decisions. The
  `caller-escalation` delta records the shape change.
- [Answer quality unverifiable] → By design: answers are information, not
  enforcement; every deterministic gate still applies to what the supervisor does
  with them.

## Migration Plan

Additive: new reason code and control type; no schema change (payload is JSON).
Rollback = revert; any `supervisor_question` rows left behind resolve through the
generic respond/cancel paths.

## Open Questions

- Should the question budget escalate (ask the caller for more questions) instead of
  hard-rejecting at the bound? Deferred — rejection with autonomy guidance is the
  simpler safe default; revisit if real goals hit the bound legitimately.
