# Verification — caller-escalation-contract

Date: 2026-07-20

## Automated evidence

- Full suite: `npm test` — **716 tests, 702 pass, 0 fail, 14 skipped** (pre-existing
  skips), duration ~60s.
- `npm run typecheck` — clean.
- New suites:
  - `src/persistence/goal-input-request-repository.test.ts` (6) — single-pending
    invariant, resolve transitions, payload round-trip, grant summation.
  - `src/runtime/agent-session/agent-session-escalation.test.ts` (12) — response
    validation rejections, standing-resolution conflicts, abandon, resume with
    observation injection, epoch grant admission, restart stability, worktree
    preservation, cancel resolution.
  - `src/backend/routes/goals-input-request.test.ts` (2) — endpoint status mapping
    over real HTTP.
  - `src/dashboard/goal-input-request-rendering.test.tsx` (3) — panel rendering,
    allowed-decision gating, standing-resolution notice.
- Modified expectations: the five tests that previously asserted terminal `blocked`
  for epoch-budget exhaustion, the circuit breaker, and continuation exhaustion now
  assert `waiting_user` + `goal.input_requested` (spec deltas made this the intended
  behavior).

## Live smoke (real HTTP + real SQLite + production wiring)

Script: in-process `createApp` on a temp SQLite file, driven entirely over HTTP.
The provider adapter was a deterministic completionless scripted adapter injected
through the existing `agentRuntimeAdapters` seam — a real CLI cannot be forced to
exhaust budgets deterministically; all routing, persistence, manager, and API
surfaces were production code paths. `maxSupervisorContinuations: 1`.

Observed output (verbatim):

```
ESCALATED: {"reasonCode":"continuation_exhausted","budget":"supervisor_continuations=1","allowedDecisions":["extend_budget","provide_guidance","abandon"]}
RESTART: goal still waiting_user, request still pending
EXTENDED: "resumed"
SECOND ESCALATION: {"budgetValue":2}
CONFLICT: 409 with standing resolution accepted
TIMELINE: [
  "goal.input_requested:supervisor.continuations_exhausted",
  "goal.input_response:goal.input_response_accepted",
  "agent.progress:escalation.resumed",
  "goal.input_requested:supervisor.continuations_exhausted",
  "goal.input_response:goal.input_response_accepted",
  "goal.blocked:goal.abandoned_by_caller"
]
PASS: escalation smoke complete
```

Covered end to end: escalation to `waiting_user`; backend restart mid-wait with the
goal and pending request surviving; `extend_budget` accepted after restart and the
goal resumed; the resumed loop running exactly one more continuation under the
extended effective budget (second escalation reports `budgetValue: 2`); 409 with the
standing resolution on a second response to the accepted request; `abandon` driving
the terminal `blocked` state; and the event timeline telling the full story in order.

## Noticed but not touched

- The `iterative-agent-loop` runtime (quorum completion gate) is a separate runtime
  from the managed control plane; escalation applies only to the managed path.
- Session-level command approvals are untouched, as scoped.
- The offline operator recovery for legacy `blocked` goals remains valid and untested
  against `waiting_user` goals (it requires continuation-exhaustion provenance on a
  `blocked` goal, which the new path only produces via `abandon`).
