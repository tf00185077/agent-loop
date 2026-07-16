# Tasks: Multi-Epoch Supervisor Loop

## 1. Domain types and control-block validation

- [x] 1.1 Add `managed_goal.reassessment` to the managed control event types plus
      `ManagedGoalReassessmentControlEvent` / `GoalReassessment` domain types
      (TDD: extend domain/control-plane type tests where they exist).
- [x] 1.2 TDD `validateManagedControlEvent` support for `managed_goal.reassessment`
      (boolean `goalSatisfied`; evidence ≥1; unsatisfied → gaps ≥1 + rationale;
      satisfied → no gaps; trimming and length caps).
- [x] 1.3 TDD relaxing the change-plan minimum from 2 to 1 in the validator.

## 2. Epoch-aware change registry

- [x] 2.1 TDD `GoalChangeRegistry` epoch metadata: `registerPlan` records epoch 1,
      `listEpochs()`, `epochCount()`, changes tagged with their epoch sequence.
- [x] 2.2 TDD `recordReassessment` (gate: plan exists, all changes archived) and
      `latestReassessment()` / `pendingNextEpoch()` state.
- [x] 2.3 TDD `registerNextEpoch` (gate: unsatisfied reassessment pending, unique
      change ids across epochs; activates the first new change).

## 3. Manager orchestration and completion gate

- [x] 3.1 TDD reassessment control-event handling in `agent-session-manager.ts`:
      timing gate (archive-then-check), flat-goal rejection, satisfied-claim
      cross-check against `evaluateManagedCompletion`, durable
      `supervisor.reassessment` event.
- [x] 3.2 TDD bounded loop: epoch budget (`maxPlanningEpochs`, default 5) and
      repeated-gap circuit breaker both move the goal to blocked durably.
- [x] 3.3 TDD next-epoch change-plan acceptance: second plan routed through
      `registerNextEpoch`, scaffolding + spec tasks registered for the new
      batch, durable change-plan event carries epoch sequence and rationale.
- [x] 3.4 TDD completion binding: completion rejected without a satisfied latest
      reassessment or with an armed next-epoch gate; accepted after a satisfied
      one.

## 4. Rehydration and prompt contract

- [ ] 4.1 TDD chronological multi-epoch replay in
      `supervisor-state-rehydration.ts` (plan → transitions → reassessment →
      next plan), with back-compat for events lacking epoch fields.
- [ ] 4.2 TDD supervisor prompt updates: reassessment rule + control example in
      the contract, epoch-aware change-history rendering.

## 5. Projection and dashboard

- [ ] 5.1 TDD `projectPlanningEpochs(events)` (new module): epochs with derived
      status, member changes with statuses, reassessment results.
- [ ] 5.2 Expose `planningEpochs` on `GET /api/goals/:id/agent-session` (route
      test) and render the epoch board in `GoalDetail.tsx` (component test).

## 6. Verification

- [ ] 6.1 Full `npm test` + `npm run typecheck` green.
- [ ] 6.2 Live smoke via the API (mock provider): multi-epoch flow — epoch 1
      archived → reassessment(false) → epoch 2 → reassessment(true) →
      completion; record evidence in `verification.md`.
