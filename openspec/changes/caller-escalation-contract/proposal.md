## Why

Today every goal-level budget bound in the managed loop terminates the goal: epoch-budget
exhaustion, supervisor-continuation exhaustion, and the repeated-gap circuit breaker all
mark the goal `blocked`, a terminal state. The caller who
started the goal — a human on the dashboard, or (per the product direction) another agent
driving auto-agent through an API/MCP surface — has no way to answer a stuck goal, grant
more budget, or supply guidance and let it continue. The only recoveries are cancel,
restart-from-scratch, or the offline operator CLI. This makes the loop a bounded batch
tool rather than a collaborating long-running agent.

## What Changes

- Introduce a goal-level **escalation contract**: when the backend would otherwise
  terminally block a recoverable goal, it instead records a durable, structured
  **input request** (reason code, evidence, remaining gaps, allowed decisions) and moves
  the goal to the non-terminal `waiting_user` status (already present in the
  `GoalStatus` union but never written today).
- The contract is **caller-agnostic**: a machine-readable request/response pair (the
  reverse direction of a control block). The caller's response is deterministically
  validated by the backend — `extend_budget`, `provide_guidance`, or `abandon` — and
  persisted durably before any effect.
- **Resume semantics**: an accepted `extend_budget`/`provide_guidance` response raises
  the relevant bound and/or injects the caller's guidance into the rehydrated supervisor
  context as an observation, then restarts the supervisor continuation loop. `abandon`
  moves the goal to terminal `blocked` exactly as today.
- **Escalation sources** (this change): the three goal-level block decisions whose
  scope is still recoverable by a caller decision — epoch-budget exhaustion, the
  reassessment circuit-breaker, and supervisor-continuation exhaustion. Change-level
  exhaustion (spec budget, task attempts) already recovers through re-planning and is
  untouched. Environment/data failures (archive capability unavailable, lineage-corrupt
  recovery) keep writing terminal `blocked` — caller input cannot repair them.
- Dashboard becomes one client of the contract: show the pending input request on the
  goal detail page with a respond affordance, mirroring the existing session-level
  approval UI.
- Restart safety: a `waiting_user` goal survives backend restart without being swept
  into interrupted-goal reconciliation; the pending request is rehydrated from durable
  state.

**Non-goals**

- No MCP server exposure in this change — the API contract is designed so an agent
  caller can drive it, but the transport ships separately.
- No push notifications/callbacks: callers observe `waiting_user` by polling goal
  status and the event timeline (the existing observability surface).
- No progress-rate heuristics or automatic budget tuning: budgets stay deterministic
  counters; exhaustion becomes a caller decision point instead of a terminal verdict.
- No change to session-level command approvals; the existing offline operator recovery
  for legacy `blocked` goals remains valid.

## Capabilities

### New Capabilities

- `caller-escalation`: the goal-level escalation contract — durable structured input
  requests, the `waiting_user` goal status, deterministic response validation
  (`extend_budget` / `provide_guidance` / `abandon`), response-driven resume with
  supervisor rehydration, restart survival, and the caller-facing API endpoints.

### Modified Capabilities

- `supervisor-goal-orchestration`: continuation exhaustion escalates to the caller
  instead of terminally blocking the goal; a resumed goal's continuation counter and
  history reflect the granted extension.
- `multi-epoch-planning`: epoch-budget exhaustion and the repeated-gap circuit breaker
  escalate instead of blocking; an extended budget admits the next epoch under the
  existing admission gates.
- `dashboard-goal-lifecycle`: `waiting_user` joins the goal status vocabulary as a
  non-terminal state with its own display treatment and a respond affordance on the
  goal detail page.

## Impact

- `src/runtime/agent-session/agent-session-manager.ts`: the block sites
  (`blockGoalForMacroLoop`, continuation-exhaustion) redirect to escalation; new
  response-handling entry point that validates, persists, and resumes via the existing
  supervisor-state-rehydration path.
- `src/persistence/`: goal status union gains `waiting_user`; new durable input
  request/response records and event types.
- `src/backend/routes/`: new goal-scoped endpoints to read the pending input request
  and post a response (modeled on the session approval routes).
- `src/dashboard/`: goal status badge + pending-request panel with respond form.
- Startup reconciliation (`reconcile-interrupted-goals`, `managed-goal-recovery`) must
  treat `waiting_user` as stable, not interrupted.
