## Why

The caller-escalation contract (shipped 2026-07-20) is single-turn and backend-initiated:
the caller only hears from a goal when a budget bound fires, and a misunderstood
guidance answer costs a full loop iteration to discover. The cheaper fix for most
clarification needs is letting the AI ask **at the moment it is stuck, while it is
alive and holds full context**: a supervisor that needs a caller decision (ambiguous
requirement, missing preference, risky trade-off) should emit one structured question,
park the goal in `waiting_user`, and continue with the answer injected — instead of
guessing, burning budget, and being second-guessed after the fact.

## What Changes

- New `managed_goal.request_input` control block: a live supervisor asks its caller
  one bounded question (plus optional context evidence strings). The backend validates
  deterministically and, when accepted, records a `supervisor_question` input request,
  moves the goal to `waiting_user`, and lets the session end without a continuation.
- **Full reuse of the existing escalation contract**: same `goal_input_requests`
  ledger, same `waiting_user` semantics, same respond API and dashboard panel. The
  question text is the request's summary; allowed decisions are `provide_guidance`
  (the answer) and `abandon` — no new response kinds, no new endpoints.
- **Backend gates (enforcement, not prompt text)**: reject the block when a pending
  input request exists, when the session has an in-flight child delegation, when the
  question is empty/oversized, or when the goal's question budget (configurable,
  default 3) is exhausted — each rejection carries a durable safe reason that teaches
  the correct next action (decide autonomously and proceed).
- **Grant semantics tightened**: implicit +1 budget grants from `provide_guidance`
  now apply only to budget-exhaustion reasons; answering a supervisor question grants
  nothing (it never consumed a budget). Escalation payload budget fields become
  nullable for question requests.
- Resume observation renders both the question and the caller's answer so the
  continuation prompt is self-contained.
- Supervisor prompt contract documents the block and its limits (prompt informs;
  validators enforce).

**Non-goals**

- No multi-turn Q&A while waiting — one question, one answer, resume. A read-only
  answer session during `waiting_user` is a separate future change.
- No worker/child-initiated questions; only the goal's supervisor.
- No new dashboard surface: the existing input-request panel renders questions
  (implementation adds only a reason label).

## Capabilities

### New Capabilities

_None — the ask flow extends existing capabilities._

### Modified Capabilities

- `caller-escalation`: reason set gains `supervisor_question` (allowed decisions
  `provide_guidance` + `abandon`); implicit grants restricted to budget reasons;
  budget payload fields nullable for question requests; resume observation carries
  question + answer.
- `supervisor-goal-orchestration`: supervisors of managed goals may emit
  `managed_goal.request_input`, gated by pending-request uniqueness, no in-flight
  delegation, question bounds, and a per-goal question budget, with durable safe-reason
  rejections.

## Impact

- `src/domain/`: `GoalInputRequestReason` + `supervisor_question`; nullable payload
  budget fields; `ManagedControlEventType` + `managed_goal.request_input`.
- `src/runtime/agent-session/delegation-control-event.ts`: shape validation for the
  new block.
- `src/runtime/agent-session/agent-session-manager.ts`: acceptance gates + escalation
  reuse; question-aware observation rendering; null-budget handling in respond flow.
- `src/persistence/goal-input-request-repository.ts`: grant allowlist fix.
- `src/runtime/agent-session/supervisor-prompt.ts`: contract documentation.
- `src/dashboard/GoalDetail.tsx`: reason label only.
