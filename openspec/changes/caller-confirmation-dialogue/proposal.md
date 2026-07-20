## Why

The escalation contract is single-turn: a caller answers once and the goal immediately
resumes a full-authority working session. Two gaps remain. First, real clarification
usually takes more than one exchange, and today the caller's answer is handed to a
session that can barrel into delegation before confirming it understood — there is no
bounded, read-only back-and-forth. Second, nothing forces the supervisor to confirm its
plan with the caller *before* doing work; it decides and acts, and the caller only sees
the escalation when a budget bound fires. The user wants mutual confirmation — the loop
proceeds only when caller and supervisor agree — not one-way input.

## What Changes

- **Conversation thread**: an input request generalizes from one summary into a durable,
  ordered thread of `{role: supervisor | caller, text, at}` messages. The goal stays in
  `waiting_user` for the whole conversation.
- **Read-only conversational turns**: a caller reply no longer resumes the working loop
  directly. The backend runs the supervisor in a **read-only turn** (deterministic
  control-block whitelist: only `managed_goal.request_input`, a new
  `managed_goal.propose_plan`, and a new `managed_goal.ready_to_proceed` are honored;
  every work-producing block is rejected). The supervisor either continues the
  conversation (asks/proposes again — thread grows, still waiting) or signals
  `ready_to_proceed`, which closes the conversation and resumes a fresh working session
  with the whole thread as context. A conversation-turn budget bounds it.
- **Multi-turn clarification** (feature 1): the existing `supervisor_question` flow now
  supports follow-ups through the thread instead of ending after one answer.
- **Mandatory propose→confirm checkpoint** (feature 2): a per-goal confirmation policy
  requires a **standing caller confirmation** before the first work-producing control
  block of each epoch. Without it, that block is rejected, forcing the supervisor to
  emit `managed_goal.propose_plan` (reason `plan_confirmation`) and converse to a
  `ready_to_proceed` first. Opening a new epoch clears the confirmation, re-arming the
  checkpoint. The policy defaults to on; a goal may opt out for the flat autonomous flow.
- **Caller controls**: within a conversation the caller may reply (continue), or choose
  `proceed` (force the loop forward without waiting for the supervisor's `ready`), or
  `abandon`. Existing `extend_budget`/`provide_guidance`/`abandon` semantics for
  budget-driven escalations are unchanged.
- Dashboard becomes a thread view with a persistent reply box until the conversation
  resolves; the API gains a thread read and generalizes the respond endpoint.

**Non-goals**

- No live/long-lived supervisor process while waiting — every conversational turn is a
  fresh, durable-state-rehydrated, read-only invocation (restart-resilient, as today).
- No child/worker participation in the conversation; only the goal's supervisor.
- No free-form caller-initiated messages when no conversation is open (the caller speaks
  only into an open thread).
- No change to how budget-exhaustion escalations decide (extend/guidance/abandon);
  they gain thread rendering but keep single-turn resolution unless the supervisor opens
  a conversation.

## Capabilities

### New Capabilities

_None — this extends existing capabilities._

### Modified Capabilities

- `caller-escalation`: input request carries a durable message thread; caller replies run
  read-only conversational turns instead of always resuming; `ready_to_proceed` closes a
  conversation and resumes; new `plan_confirmation` reason; `proceed` caller decision;
  conversation-turn budget; read-only enforcement whitelist.
- `supervisor-goal-orchestration`: supervisors may emit `managed_goal.propose_plan` and
  `managed_goal.ready_to_proceed`; a per-goal confirmation policy gates the first
  work-producing control block of each epoch on a standing confirmation, re-armed per
  epoch; conversational turns reject work-producing blocks deterministically.

## Impact

- `src/domain/`: input-request payload gains a `thread` and `phase`; new reason
  `plan_confirmation`; new caller decision `proceed`; `ManagedControlEventType` gains
  `managed_goal.propose_plan` and `managed_goal.ready_to_proceed`.
- `src/persistence/goal-input-request-repository.ts`: append-message + phase transitions
  + standing-confirmation query.
- `src/runtime/agent-session/delegation-control-event.ts`: validation for the two new
  blocks.
- `src/runtime/agent-session/agent-session-manager.ts`: read-only conversational turn
  (whitelist), `ready_to_proceed`/`proceed` transitions, the confirm-before-work gate,
  per-epoch confirmation re-arm, conversation-turn budget.
- `src/runtime/agent-session/supervisor-prompt.ts`: contract for proposing, conversing,
  and signalling ready; the confirmation policy.
- `src/backend/routes/goals.ts`: thread read; respond endpoint returns conversational
  outcomes.
- `src/dashboard/GoalDetail.tsx`: thread view + persistent reply box + confirm/revise/
  proceed/abandon affordances.
