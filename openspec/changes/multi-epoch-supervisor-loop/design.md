# Design: Multi-Epoch Supervisor Loop

## Context

Today `GoalChangeRegistry` accepts exactly one `managed_change.plan` per goal
(`registerPlan` rejects a second plan), completion requires
`allArchived() && evaluateManagedCompletion(...).ok`, and the plan itself is
persisted as one `supervisor.change_plan` durable event replayed by
`rehydrateChangeRegistry`. There is no goal-level reassessment concept: once
the registered work finishes, the goal can complete even if the original goal
still has unregistered gaps, and no new work can ever be registered after all
changes archive.

Constraints that shape this design (CLAUDE.md, non-negotiable):

- Backend validators enforce every deterministic rule; prompts only inform.
- Durable events are the source of truth; in-memory registries are working
  state and may reset on restart.
- Degrade visibly; sanitize provider output; no new side-effect channels for
  agents.

## Goals / Non-Goals

**Goals:**

- Every planned goal cycles: plan epoch → execute batch → archive all →
  reassess against the original goal → next epoch or completion.
- Deterministic backend gates for: reassessment timing, satisfied-claim
  cross-check, next-epoch admission, completion binding, epoch budget,
  repeated-gap circuit breaker.
- Restart recovery restores epoch position and judgment history from events.
- Epoch state is observable via events, API projection, and the dashboard.

**Non-Goals:**

- No new SQLite tables (events carry the epoch/reassessment ledger).
- No changes to the flat (no-plan) goal flow other than sharing the relaxed
  plan minimum.
- No user-editable next-epoch plans in this change (the gap doc mentions
  allowing user adjustment; that is follow-up UX).

## Decisions

### D1: Epochs live in the change registry, persisted as events

Each accepted `managed_change.plan` opens one epoch. `GoalChangeRegistry`
gains `epochs` metadata (sequence, rationale, changeIds), a flat change list
tagged with `epochSequence`, and reassessment records. Durable persistence
reuses the existing pattern: the `supervisor.change_plan` event now carries
`epochSequence`/`epochRationale`, and a new `supervisor.reassessment` event
carries the validated judgment. Rehydration replays all events
chronologically (plan → transitions → reassessment → plan → …).

*Alternative considered*: dedicated `goal_planning_epochs` +
`goal_reassessments` tables. Rejected for this change: the events ledger is
already the durable source of truth for the change plan itself, replay is
already the recovery mechanism, and the events API/SSE expose new entities
for free. Tables can be introduced later behind the same registry API if
query needs grow.

### D2: One new control block, `managed_goal.reassessment`

Shape (validated in `delegation-control-event.ts`):

```json
{
  "type": "managed_goal.reassessment",
  "goalSatisfied": false,
  "evidence": ["..."],
  "remainingGaps": ["..."],
  "nextEpochRationale": "..."
}
```

Validation: `goalSatisfied` boolean; `evidence` ≥1 non-empty strings; when
`goalSatisfied=false`, `remainingGaps` ≥1 and `nextEpochRationale` non-empty;
when `true`, `remainingGaps` must be empty/absent. Strings are trimmed and
length-capped before persisting.

Manager gates (in order):

1. Goal must have a change plan (flat goals are rejected with a safe reason —
   their completion path is unchanged).
2. `tryArchiveActiveChange` first (same courtesy as the completion path),
   then all changes across all epochs must be archived.
3. A `goalSatisfied=true` claim is cross-checked against
   `evaluateManagedCompletion`; durable gaps reject the claim (prompt text is
   not enforcement — the durable ledger outranks the supervisor's prose).
4. Circuit breaker: `goalSatisfied=false` with a remaining-gap signature
   (normalized: trim/lowercase/sort/join) identical to the previous
   reassessment's blocks the goal (`goal.blocked`, durable reason).
5. Epoch budget: `goalSatisfied=false` when `epochCount >= maxPlanningEpochs`
   (deps option, default 5) blocks the goal.
6. Otherwise the judgment is recorded in the registry and as a
   `supervisor.reassessment` event; `goalSatisfied=false` arms the
   next-epoch gate.

### D3: Next-epoch admission is a registry gate, not prompt text

`registerNextEpoch(changes, rationale)` succeeds only when the latest
reassessment is unsatisfied and no epoch was registered after it, and all new
change ids are unique across the whole goal. The manager routes a
`managed_change.plan` from a goal that already has a plan through this gate;
everything downstream (scaffolding, spec tasks, one-active-change
sequencing) reuses the existing epoch-1 code path. AC3 holds because the gate
is unreachable without a recorded unsatisfied reassessment.

### D4: Completion binds to the latest reassessment

For planned goals, `managed_delegation.complete` additionally requires
`latestReassessment.goalSatisfied === true` and no armed next-epoch gate.
Rejections name the missing step ("emit managed_goal.reassessment"). The
existing `evaluateManagedCompletion` check stays; the reassessment is
additive (Non-Goal: no evidence relaxation).

### D5: Plan minimum drops to 1

Follow-up epochs legitimately need single-change batches (e.g. a final
verification change), and AC1 allows small planned goals one change in one
epoch. The 2–8 budget becomes 1–8 in the shared validator; the "small goals
may skip planning entirely" prompt guidance is unchanged.

### D6: Projection is a pure event fold

New `projectPlanningEpochs(events)` folds the durable events into
`[{ sequence, rationale, status, changes: [{id,title,status}], reassessment }]`
with epoch status derived: `executing` (unarchived changes remain),
`reassessing` (all archived, no judgment yet), `completed` (satisfied
judgment), `gaps_found` (unsatisfied judgment), `blocked` (any member change
blocked / goal blocked during the epoch). Exposed as `planningEpochs` on
`GET /api/goals/:id/agent-session`; `GoalDetail.tsx` renders an epoch board
(per-epoch change cards with status + latest reassessment summary). SSE
needs nothing new — the events already stream.

## Risks / Trade-offs

- [Supervisor never emits a reassessment and keeps exiting] → the existing
  completionless-continuation budget (default 10) already bounds this; each
  continuation prompt now names the reassessment as the required next step.
- [Gap-signature circuit breaker is text-based and could be evaded by
  paraphrasing] → the epoch budget is the hard stop; the signature breaker is
  an early exit for the obvious repeat-loop case.
- [Event-sourced epochs make ad-hoc SQL over epochs harder] → acceptable at
  current scale; the projection function is the single query surface and a
  table can replace it behind the same registry/projection API later.
- [Old goals with pre-change events lack `epochSequence`] → replay treats the
  first `supervisor.change_plan` event as epoch 1 with `null` rationale;
  no migration needed.

## Migration Plan

Pure code change; no schema migration. Existing in-flight goals rehydrate as
epoch 1. Completion of previously-planned goals now additionally requires a
reassessment — this is the intended behavior change (AC5) and only affects
goals that have a change plan and have not yet completed.
