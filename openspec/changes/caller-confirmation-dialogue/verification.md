# Verification — caller-confirmation-dialogue

Date: 2026-07-20

## Automated evidence

- Full suite: `npm test` — **745 tests, 731 pass, 0 fail, 14 skipped**
  (pre-existing skips), duration ~64s.
- `npm run typecheck` — clean.
- New / extended suites:
  - `src/domain/goal-input-request.types.test.ts` — conversation reasons allow
    guidance+proceed+abandon; grants only for budget reasons.
  - `src/persistence/goal-input-request-repository.test.ts` — thread append +
    phase round-trip.
  - `src/persistence/goal-repository.test.ts` / `database.test.ts` —
    confirmation_policy column defaults off, honors required.
  - `src/runtime/agent-session/delegation-control-event.test.ts` — propose_plan
    and ready_to_proceed validation and bounds.
  - `src/runtime/agent-session/agent-session-dialogue.test.ts` (6) — multi-turn
    read-only conversation to ready_to_proceed; work block rejected read-only;
    caller proceed; conversation-turn budget; the required-policy checkpoint
    rejects a delegation until confirmed; off bypasses.
  - `src/runtime/agent-session/agent-session-question.test.ts` — a question now
    runs a read-only conversational turn.
  - `src/runtime/agent-session/supervisor-prompt.test.ts` — contract text.
  - `src/backend/routes/goals-input-request.test.ts` — thread exposed over the
    API; proceed/guidance accepted.
  - `src/dashboard/goal-input-request-rendering.test.tsx` — thread chat, reply
    box, proceed affordance, awaiting-supervisor hint.

## Live smoke (real HTTP + real SQLite + production wiring)

Script: in-process `createApp` on a temp SQLite file, driven over HTTP; the
provider adapter is a deterministic scripted supervisor injected through the
existing `agentRuntimeAdapters` seam. Goal created with
`confirmationPolicy: "required"`.

Observed timeline (verbatim event `runtimeEventType` sequence):

```
PROPOSED: {"reason":"plan_confirmation","threadLen":1,"decisions":["provide_guidance","proceed","abandon"]}
WORK-BEFORE-CONFIRM REJECTED: "This goal requires caller confirmation before work. Emit a managed_go..."
READY → RESUMED: "resumed"
TIMELINE: ["delegation.rejected","supervisor.plan_proposed","conversation.caller_replied",
  "conversation.turn_started","delegation.rejected","conversation.supervisor_replied",
  "conversation.caller_replied","conversation.turn_started","goal.plan_confirmed",
  "conversation.resolved","conversation.resumed","delegation.accepted"]
WORKER DISPATCHED AFTER CONFIRMATION: true
PASS: confirmation-dialogue smoke complete
```

Covered end to end under the `required` policy: the supervisor's first
delegation is rejected asking it to confirm first; it emits `propose_plan`
opening a `plan_confirmation` thread; the caller replies, and a work block
attempted mid-conversation is rejected read-only; the supervisor asks again; the
caller replies a second time; the supervisor signals `ready_to_proceed`, which
records the standing confirmation and resumes a fresh working session; only then
is the worker delegation accepted. The whole exchange is one durable thread.

## Design refinement during implementation (noticed and applied)

- The re-arm signal was narrowed from "any plan-restatement (change.plan or
  task_list)" to **managed_change.plan only**. Clearing on task_list would
  re-reject a just-confirmed plan's own task list (confirm → task_list →
  delegation would wrongly fail). change.plan is the unambiguous new-epoch /
  re-plan signal. The `supervisor-goal-orchestration` delta and the design were
  updated to match.
- `supervisor_question` (from the prior change) is now a conversation reason, so
  answering it runs a read-only conversational turn instead of resuming
  directly — the intended generalization, with its shipped test updated.

## Noticed but not touched

- Standing confirmation is a durable-event projection (`goal.plan_confirmed`
  vs `supervisor.change_plan`); no new table, restart-safe by construction.
- A distinct "confirm before declaring done" checkpoint (gating
  managed_delegation.complete) remains out of scope; the work gate already
  prevents completion without confirmed work.
