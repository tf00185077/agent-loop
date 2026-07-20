# Verification — supervisor-request-input

Date: 2026-07-20

## Automated evidence

- Full suite: `npm test` — **726 tests, 712 pass, 0 fail, 14 skipped**
  (pre-existing skips), duration ~84s.
- `npm run typecheck` — clean.
- New / extended suites:
  - `src/runtime/agent-session/delegation-control-event.test.ts` — well-formed
    `managed_goal.request_input` accepted; empty/oversized question, >5 context
    strings, oversized context, non-array context rejected naming the bounds.
  - `src/runtime/agent-session/agent-session-question.test.ts` (5) — valid
    question parks the goal as a `supervisor_question` request with null budget
    fields and no continuation; answer resumes with the Q+A observation and
    grants no budget; abandon blocks; in-flight-delegation question rejected;
    over-budget question rejected with autonomy guidance.
  - `src/persistence/goal-input-request-repository.test.ts` — accepted question
    guidance grants no budget.
  - `src/runtime/agent-session/supervisor-prompt.test.ts` — contract text +
    limits present.
  - `src/dashboard/goal-input-request-rendering.test.tsx` — question renders with
    guidance/abandon only.

## Live smoke (real HTTP + real SQLite + production wiring)

Script: in-process `createApp` on a temp SQLite file, driven over HTTP; the
provider adapter is a deterministic scripted supervisor injected through the
existing `agentRuntimeAdapters` seam (a real CLI cannot be forced to emit a
question deterministically). `maxSupervisorQuestions: 1`.

Observed output (verbatim):

```
QUESTION: {"reasonCode":"supervisor_question","decisions":["provide_guidance","abandon"],"budgetName":null}
ANSWERED: "resumed"
RESUME OBSERVATION: contains Q and A
OVER-BUDGET REJECTION: "The goal's question budget (1) is exhausted; decide autonomously using your best judgment and proceed."
GOAL STATUS AFTER OVER-BUDGET ASK: waiting_user
PASS: supervisor question smoke complete
```

Covered end to end: a live supervisor emits `managed_goal.request_input`
mid-run; the goal parks in `waiting_user` with a machine-readable
`supervisor_question` request served by the existing input-request endpoint;
`provide_guidance` resumes the goal with the continuation prompt carrying both
the question and the answer; a second question after the budget is exhausted is
rejected with the autonomy-teaching safe reason. (The trailing `waiting_user`
is the continuation-exhaustion escalation the scripted never-completing
supervisor triggers afterward — unrelated to the question flow.)

## Wiring fix found during the smoke

`createApp` did not forward `maxSupervisorQuestions` to the session manager
(only `maxSupervisorContinuations` was wired). Added the option and forwarded
it, symmetric with the existing continuation bound, so operators can tune the
question budget and tests can exercise it.

## Noticed but not touched

- A goal already in `waiting_user` now rejects all further control blocks from a
  trailing session, not only questions — a small hardening beyond the stated
  scope, covered by the happy-path test's "no continuation while waiting" check.
- Multi-turn clarification while waiting remains out of scope (a read-only answer
  session is the natural next change).
