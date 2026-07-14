## Why

The managed pipeline now has durable Supervisor, Worker, Judge, Integrator,
re-Judge, delivery, validation, rollback, approval, and restart states. The
dashboard exposes their detailed records, but users still lack one compact,
trustworthy answer to "what is happening right now?" A prose/event-only reducer
is no longer sufficient because structured SQLite records are the authority for
current task, review, delivery, and integration state.

## What Changes

- Add a compact live-status contract with a coarse `state` and a role-aware
  `phase` instead of an ever-growing flat status enum.
- Project current status from durable goal, session, approval, delegation,
  managed-task, review/delivery, and integration records using an explicit
  precedence order.
- Use sanitized durable events only to supplement last activity and a bounded
  summary; event prose never overrides structured current state.
- Include safe provider/model and exact runtime identities when available:
  session, parent session, delegation, role, task, integration attempt, and
  resolved candidate.
- Add the projection to the existing goal-scoped agent-session snapshot.
- Render one compact current-activity panel above the existing detailed
  session/delegation/task views and event timeline.
- Reuse the existing event stream as a refresh trigger; add no second live
  transport or browser-owned state machine.

## Capabilities

### New Capabilities
- `agent-live-status`: Defines the authoritative durable live-status projection,
  precedence rules, API contract, and compact dashboard presentation.

### Modified Capabilities
- `dashboard-goal-lifecycle`: The goal detail dashboard SHALL show compact
  current activity in addition to existing durable detail and timeline views.

## Impact

- Affects shared domain/view-model types, a focused runtime projection module,
  the existing `/api/goals/:id/agent-session` response, dashboard goal detail,
  and tests.
- Depends on the existing sanitized session/delegation and managed-task
  projections, including conditional integration recovery.
- Adds no scheduler, provider execution behavior, database schema, new SSE
  protocol, raw provider payload, or replacement for existing detailed views.
