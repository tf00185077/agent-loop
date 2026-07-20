## Context

Three backend decisions currently write the terminal goal status `blocked` for scope
that a caller decision could still recover:

- `blockGoalForMacroLoop` (agent-session-manager.ts ~3172) — fired for
  `supervisor.epoch_budget_exhausted` and `supervisor.reassessment_circuit_breaker`.
- Continuation exhaustion (~3279) — `maxSupervisorContinuations` reached without a
  completion signal.

Both fire while a live supervisor session is being processed; after the block the
session ends and the goal is dead. The caller (dashboard human today; another agent via
a future MCP transport) has no channel to answer.

Existing machinery this change builds on:

- **Session-level approvals**: `approval.requested` → durable approval request →
  `waiting_approval` lifecycle → dashboard approve/reject → `manager.approve()`. The
  pattern (durable request, status gate, API, thin UI) is copied one level up.
- **`waiting_user`**: already in the `GoalStatus` union and handled by
  `agent-live-status.ts`, but never written. This change activates it.
- **Fresh continuation**: `continueSupervisorAfterChild` (~3364) builds a continuation
  prompt from rehydrated registries and starts a fresh supervisor session when no
  resumable handle exists. Escalation resume reuses this shape.
- **Rehydration**: `supervisor-state-rehydration.ts` + `resume-interrupted-goals`
  already rebuild registries from durable rows for cold resume.

## Goals / Non-Goals

**Goals:**

- `waiting_user` as a stable, restart-surviving, non-terminal goal state with exactly
  one open input request at a time.
- A machine-readable request/response contract validated deterministically by the
  backend (prompt text is not enforcement; caller text is not enforcement either).
- Resume that reuses the existing continuation/rehydration path, with the caller's
  decision injected as an observation.
- Durable events for every transition (requested, response accepted/rejected, resumed,
  abandoned) written before any stream or side effect.

**Non-Goals:**

- MCP transport, push notifications, supervisor-initiated escalation
  (a `managed_goal.request_input` control block), progress-rate budget heuristics,
  retroactive recovery of already-`blocked` goals (the operator CLI keeps that role).

## Decisions

**D1 — Reuse `waiting_user`, do not add `waiting_input`.** The union value exists,
live-status already maps it, and a distinct name avoids confusion with the *session*
lifecycle state `waiting_input`. Goal level = `waiting_user` (who: the caller),
session level = `waiting_approval`/`waiting_input` (unchanged).

**D2 — Input requests are goal-scoped durable rows, not session approvals.** New
`goal_input_requests` table: `id`, `goalId`, `reasonCode`
(`epoch_budget_exhausted` | `reassessment_circuit_breaker` | `continuation_exhausted`),
`safeSummary`, `payload` (JSON: evidence, remaining gaps in the reassessment gap shape,
exhausted budget name + current value, `allowedDecisions`), `status`
(`pending` | `accepted` | `abandoned` | `cancelled`), `response` (JSON), timestamps.
Session approvals stay command-scoped; mixing the two would couple goal recovery to a
session that no longer exists.

**D3 — Allowed decisions vary by reason code, carried in the request.**
- `epoch_budget_exhausted` / `continuation_exhausted`: `extend_budget`,
  `provide_guidance` (guidance implies a minimal +1 grant so the loop can act on it),
  `abandon`.
- `reassessment_circuit_breaker`: `provide_guidance`, `abandon` — extending budget
  without new information would repeat the loop the breaker just caught.
The backend validates the response's `decision` against the stored `allowedDecisions`;
anything else is rejected with a safe reason (mirror of control-block validation,
reverse direction).

**D4 — Effective budgets are derived, not mutated.** No mutable budget columns.
Effective budget = configured base + sum of accepted `extend_budget` grants for that
goal (grants bounded per response: integer 1..base). Both live checks
(`epochCount() >= max`, continuation count >= max) switch to the derived value, and
rehydration recomputes it from durable rows, so restart cannot lose a grant. This
matches the project's event-sourced style.

**D5 — Escalation ends the supervisor session; resume is always a fresh continuation.**
At escalation time the manager records the input request + events, sets the goal to
`waiting_user`, and closes the live session out (as the fresh-continuation branch
already does for superseded sessions). Resume never tries `handle.send({resume})` —
the session is long gone by the time a caller answers. It follows
`continueSupervisorAfterChild`'s fresh branch: rehydrate registries, build a
continuation prompt whose observation is a deterministic rendering of the caller's
decision ("Caller granted N more epochs", "Caller guidance: …"), create run + session,
run the event loop. Alternative considered: keeping the handle alive in
`waiting_input` — rejected because callers may answer hours later and across restarts.

**D6 — Response endpoint is goal-scoped and idempotent-safe.**
`GET /api/goals/:id/input-request` returns the pending request (404 when none).
`POST /api/goals/:id/input-request/:requestId/respond` validates: request exists, is
`pending`, belongs to the goal, decision allowed, fields well-formed
(`extension` integer in range for `extend_budget`; non-empty bounded `guidance` string
for `provide_guidance`). On accept: persist response + `goal.input_response` event,
then apply (resume or terminal block). A second respond on a non-pending request gets
409 with the standing resolution. Cancel of a `waiting_user` goal resolves the request
as `cancelled`.

**D7 — Event ordering.** `goal.input_requested` event → status update to
`waiting_user` (both before the escalation returns); `goal.input_response` event →
resume side effects. The pending request is fully reconstructible from the table alone;
events are the observability trail.

**D8 — Startup reconciliation treats `waiting_user` as stable.** The interrupted-goal
sweep and worktree reclamation skip lists gain `waiting_user` alongside terminal
states — except worktree reclamation must NOT reclaim a waiting goal's worktrees
(scope is still live). Verify both skip-list sites explicitly in tests.

**Boundaries** (per project rules): dashboard talks only to the new REST endpoints;
all validation/side effects live in the manager (backend owns side effects); the
provider adapter is untouched — escalation is invisible to providers; SQLite owns the
request/response records.

## Risks / Trade-offs

- [Stale supervisor context after a long wait] The repo may have drifted while the goal
  waited. → Resume goes through full rehydration (registries from durable rows), and
  the continuation prompt already carries durable task/change history; drift beyond
  that is the same risk `resume-interrupted-goals` already accepts.
- [Caller grants budget forever, goal loops indefinitely] → Each grant is bounded
  (1..base) and every exhaustion re-escalates; the caller must keep affirming. The
  repeated-gap breaker still fires independently of budget.
- [Guidance is prompt text, not enforcement] A caller's guidance cannot be validated
  semantically. → By design: guidance informs the supervisor; all deterministic gates
  (contracts, admission, validation) still apply unchanged.
- [Two goals of the same manager escalating concurrently] Registry caches are per-goal
  already; the request table is keyed by goal; no shared mutable state is added.
- [Dashboard shows a stale pending panel after another client responds] → Panel
  refetches on the existing event stream signal; respond returns 409 with the standing
  resolution, which the UI renders.

## Migration Plan

Purely additive: new table (created on startup like existing repos), dormant status
activated, new endpoints. No data migration; existing `blocked` goals stay `blocked`
(operator CLI unchanged). Rollback = revert; `waiting_user` rows would then be treated
as unknown-but-nonterminal by old code paths, which never enumerate `waiting_user` in
terminal lists — acceptable for a dev-stage product.

## Open Questions

- Should `provide_guidance` on `continuation_exhausted` grant +1 continuation or
  require an explicit paired `extend_budget`? Current design: implicit +1 (simplest
  caller experience); revisit if grants need auditing separately.
- Supervisor-initiated escalation (`managed_goal.request_input` control block) is the
  natural next change once this contract exists.
