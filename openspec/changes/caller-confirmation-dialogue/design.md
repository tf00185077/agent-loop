## Context

Two shipped changes built the escalation machinery: `caller-escalation-contract`
(durable `goal_input_requests`, `waiting_user`, respond API, resume via
`resumeGoalFromDurableProjection`) and `supervisor-request-input`
(`managed_goal.request_input`, the `supervisor_question` reason, the
"waiting_user rejects all control blocks" gate). Both are single-turn: a caller reply
resolves the request and resumes a full-authority working session.

The load-bearing architectural fact (unchanged): **while a goal waits, the supervisor
process is gone.** Every resume is a fresh session rehydrated from durable state. Any
conversation must therefore live in durable storage, not in a live process — a caller
may reply hours later or after a restart.

This change turns the one-shot request into a durable conversation and inserts a
read-only phase where the supervisor's work authority is suspended until caller and
supervisor reach `ready_to_proceed`.

## Goals / Non-Goals

**Goals:**

- Multi-turn, read-only clarification on `waiting_user`, restart-resilient and bounded.
- A mandatory (per-goal-policy) propose→confirm checkpoint before work each epoch.
- Reuse the escalation ledger, `waiting_user`, resume, and dashboard panel; single-turn
  budget escalations keep working unchanged.
- Read-only guarantee enforced by backend validators, never prompt text.

**Non-Goals:**

- Live supervisor during waiting; child participation; caller messages with no open
  conversation; timeouts/auto-proceed. Changing budget-escalation resolution.

## Decisions

**D1 — Conversation lives as a durable thread on the input request.** The request's
payload gains `thread: Array<{ role: "supervisor" | "caller"; text: string; at: string }>`
and a `phase: "awaiting_caller" | "awaiting_supervisor" | "resolved"`. The opening
supervisor question/proposal is thread entry 0. A caller reply appends and flips phase to
`awaiting_supervisor`; a conversational turn appends the supervisor's next message and
flips back to `awaiting_caller`, or emits `ready_to_proceed` → `resolved`. The single
durable row already survives restart (proven by `caller-escalation`); the thread rides
inside it. Alternative (separate messages table) rejected: no query needs it and the
single-row invariant keeps restart trivial.

**D2 — Caller replies run a read-only conversational turn, not a working resume.**
Today `respondToGoalInputRequest` with `provide_guidance` calls
`resumeGoalFromDurableProjection` straight into a working session. New flow: for a
conversation-type request (`supervisor_question`, `plan_confirmation`), an accepted
reply appends to the thread and starts a **conversational turn** — the same fresh-session
rehydration, but the session runs under a control-block whitelist. Budget-driven reasons
(`epoch_budget_exhausted`, etc.) keep their existing single-turn resume unless the
supervisor chooses to open a conversation.

**D3 — Read-only enforcement is a validator whitelist, not a prompt.** During a
conversational turn the goal is `waiting_user` with `phase = awaiting_supervisor`.
`persistDelegationControlEvent` already rejects all control blocks in `waiting_user`;
this change replaces "reject all" with "allow only `managed_goal.request_input`,
`managed_goal.propose_plan`, `managed_goal.ready_to_proceed`; reject everything else with
a durable safe reason that the turn is read-only." This is the project's core lesson
applied: the read-only guarantee is deterministic backend state, immune to prompt drift.

**D4 — `ready_to_proceed` is the single unlock, and it is the supervisor's.** Only when
the supervisor emits `managed_goal.ready_to_proceed` does the conversation close and a
fresh **working** session start with the whole thread as the continuation observation.
This gives the "mutual confirmation" property: the loop advances only when the supervisor
affirms it has what it needs. The caller's independent exits are `proceed` (force-close
the conversation and resume even if the supervisor has not signalled — the caller's
override) and `abandon` (terminal block). Alternative (caller reply auto-unlocks)
rejected: it recreates today's "answer handed to an unpaused session" problem.

**D5 — The confirm-before-work checkpoint is a per-epoch gate keyed on a standing
confirmation.** A goal carries a `confirmationPolicy` (`required` default, or `off`).
When `required`, the first work-producing control block of an epoch —
`managed_delegation.request` or `managed_change.plan` — is rejected unless a standing
confirmation exists for the current epoch, with a safe reason instructing the supervisor
to `propose_plan` and converse to `ready_to_proceed` first. A `ready_to_proceed` that
closes a `plan_confirmation` conversation records the standing confirmation for the
current epoch. Opening the next epoch clears it (mirrors how `supervisor-spec-approval`
clears approval on a new attempt), re-arming the checkpoint. Flat goals treat "epoch 0"
as the single checkpoint.

**D6 — `propose_plan` is a distinct block/reason so the dashboard can render confirm
affordances.** `managed_goal.propose_plan { summary, items?: string[] }` opens a
`plan_confirmation` request (allowed caller decisions: `provide_guidance` = confirm or
correct, `proceed`, `abandon`). Free-form questions keep `supervisor_question`. Both are
conversation types under D2; the reason only drives labels and which gate they satisfy.

**D7 — Bounds.** A per-goal conversation-turn budget (default e.g. 6 supervisor turns
across all its conversations, config via manager option like `maxSupervisorQuestions`)
prevents an infinite ask/propose loop; exhaustion resolves the conversation with a safe
reason telling the supervisor to proceed on its best understanding (and, under a
`required` policy, records a forced standing confirmation so the goal is not deadlocked).

**D8 — Outcomes and restart.** `respondToGoalInputRequest` outcomes gain
`conversation_continued` (supervisor asked again → still `waiting_user`) alongside
`resumed`/`abandoned`. A conversational turn that exits without any whitelisted block is
re-prompted once, then left `awaiting_caller` on the safe side. `waiting_user` remains
restart-stable; a conversational turn interrupted by a restart is simply re-run when the
caller next replies, because the thread is the source of truth.

**Boundaries**: control-block extraction stays provider-pure; whitelist + gates live in
the manager/validator; SQLite owns the thread; dashboard talks only to existing +
generalized endpoints.

## Risks / Trade-offs

- [Read-only leak — a work block slips through a conversational turn] → D3 whitelist is a
  deterministic gate with explicit tests per work-block type; the turn cannot delegate,
  plan, or complete.
- [Deadlock — policy `required` but the conversation never reaches ready] → D7 turn
  budget forces a resolution; caller `proceed` is always available.
- [Extra latency/round-trips vs single-turn] → Only conversation-type reasons pay it;
  budget escalations keep single-turn resolution; conversational turns do no work so
  they are cheap.
- [Existing single-turn tests/clients] → Additive: thread of length 1 + immediate
  `ready_to_proceed` reproduces today's behavior; `caller-escalation` delta records the
  payload/outcome additions.

## Migration Plan

Additive JSON payload fields and new control types; new nullable `confirmation_policy`
column on goals (default `required`). No data migration; existing pending requests read
as single-entry threads. Rollback = revert; thread fields are ignored by old code.

## Open Questions

- Should `confirmationPolicy` default to `required` for ALL goals, or only when the goal
  is created through a caller that declares interactivity? Proposal defaults `required`
  to match the user's stated preference; revisit if autonomous batch goals feel gated.
- Should the checkpoint re-arm on a *materially changed* plan mid-epoch, not only on a
  new epoch? Deferred — per-epoch re-arm is the simple, well-defined MVP.
