# Multi-Epoch Supervisor Loop

## Why

The supervisor currently builds exactly one change plan per goal and can only
execute inside that fixed plan; once every registered change is archived the
system forbids new work and the goal completes on registered-task evidence
alone. `docs/product-gaps/multi-epoch-supervisor-loop.md` (Critical) shows the
product needs a macro loop: after each batch of changes is delivered, the
supervisor must re-read the original goal against the delivered evidence and,
when gaps remain, open a next planning epoch with a new batch of independently
trackable changes — bounded, durable, and observable — before the goal may
complete.

## What Changes

- Planned goals gain durable **planning epochs**: each `managed_change.plan`
  control block opens one epoch (sequence, rationale, its batch of changes);
  later epochs are only accepted after a goal-level reassessment found gaps.
- New **`managed_goal.reassessment` control block**: after all changes of the
  current epoch are archived the supervisor must emit a structured judgment
  (`goalSatisfied`, `evidence`, `remainingGaps`, `nextEpochRationale`). The
  backend validates it, cross-checks a satisfied claim against durable
  completion evidence, and persists it as a durable event.
- **Completion gate binding**: for planned goals, `managed_delegation.complete`
  is rejected unless the latest reassessment exists, is `goalSatisfied=true`,
  and no next epoch is pending — in addition to today's archived/graph checks.
- **Bounded macro loop**: a per-goal planning-epoch budget and a repeated-gap
  circuit breaker (identical remaining-gap signatures on consecutive
  reassessments) move the goal to `blocked` with durable reasons instead of
  unbounded epoch/task growth.
- Change plans may now contain **1–8 changes** (was 2–8) so follow-up epochs
  can consist of a single verification/fix change and small goals can run a
  single-change epoch.
- **Restart recovery** replays multiple change-plan events and reassessment
  events chronologically so the goal resumes in the same epoch with the same
  judgment history.
- **Projection**: the agent-session snapshot exposes `planningEpochs`
  (epoch sequence, rationale, status, member changes, reassessment results)
  derived from durable events; the dashboard goal detail renders an epoch
  board so users see which round the goal is in and why the next round exists.
- Supervisor prompt contract documents the reassessment step and renders
  epoch state in continuations (informational only; all rules enforced by
  backend validators).

## Capabilities

### New Capabilities

- `multi-epoch-planning`: planning-epoch lifecycle — epoch-scoped change
  batches, the goal reassessment control block and its gates, the
  reassessment-bound completion gate, bounded-loop budgets/circuit breaker,
  restart recovery of epoch state, and epoch observability (events, API
  projection, dashboard rendering).

### Modified Capabilities

- `goal-scale-decomposition`: "one plan per goal" becomes "one plan per
  planning epoch, next epochs gated on an unsatisfied reassessment"; the
  change-count budget becomes 1–8; the completion requirement extends from
  "all changes archived" to "all changes archived across all epochs and the
  latest reassessment is satisfied".

## Impact

- `src/domain/agent-runtime-control-plane.types.ts`: new control event type +
  reassessment/epoch types.
- `src/runtime/agent-session/delegation-control-event.ts`: validate
  `managed_goal.reassessment`; relax plan minimum to 1.
- `src/runtime/agent-session/change-registry.ts`: epoch-aware registry
  (next-epoch registration gates, reassessment records, epoch listing).
- `src/runtime/agent-session/agent-session-manager.ts`: reassessment
  enforcement, next-epoch change-plan acceptance, completion-gate binding,
  epoch budget + circuit breaker.
- `src/runtime/agent-session/managed-completion-evaluator.ts`: unsatisfied /
  missing reassessment surfaces as a durable completion gap.
- `src/runtime/agent-session/supervisor-state-rehydration.ts`: chronological
  multi-epoch replay.
- `src/runtime/agent-session/supervisor-prompt.ts`: contract text + epoch
  rendering.
- `src/backend/routes/goals.ts` + new projection module: `planningEpochs` in
  the agent-session snapshot.
- `src/dashboard/GoalDetail.tsx`: epoch board rendering.
- SQLite: no new tables — epochs and reassessments persist as durable events
  (same pattern as the existing change plan), which the events API and SSE
  stream already expose.

## Non-Goals

- No pre-declared future epochs: every next epoch must come from a recorded
  unsatisfied reassessment, never from the initial plan.
- No forced multi-epoch flow: small planned goals may finish after one epoch
  and one satisfied reassessment; flat (unplanned) goals keep today's flow.
- No relaxation of existing completion evidence: the reassessment gate is
  additive to the durable completion evaluator, not a replacement.
- No provider/model selection changes and no new external services.
