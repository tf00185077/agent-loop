## 1. Enumerate interrupted goals

- [x] 1.1 Write a failing test for listing goals in `interrupted` status (repository query or filter).
- [x] 1.2 Implement the interrupted-goal listing on the goal repository.

## 2. Registry rehydration (TDD)

- [x] 2.1 Write a failing test that rehydrating a goal's task registry from durable `managed_tasks` rows yields the same task list structure (ids, titles, acceptance criteria, parent links, change ids) as was originally registered.
- [x] 2.2 Write a failing test that rehydrating the change registry from durable change-plan rows restores the plan and its merged/active state.
- [x] 2.3 Implement `rehydrateRegistriesFromDurable(deps, state, goalId)`: rebuild the task registry via `registerTaskList` from `managedTaskRepo` rows and the change registry via `registerPlan` + replay of durable merged/active change state. Keep the durable projection authoritative.

## 3. Resume entry point (TDD)

- [x] 3.1 Write failing tests for `resumeInterruptedGoal`: given an `interrupted` goal with durable task history, it rehydrates the registries, flips the goal to `running`, starts a supervisor session whose prompt is a **continuation** carrying the durable projection (not a bootstrap), and records a durable `recovery.resumed` event; a goal not in `interrupted` is not resumed; a resume whose session start throws is recorded durably and leaves the goal non-`running`.
- [x] 3.2 Implement `resumeInterruptedGoal({ goalId, providerId, modelLabel, adapter })` on the manager: guard on `interrupted`, rehydrate registries, build the continuation prompt (`buildSupervisorPrompt` continuation + `projectManagedTaskContext` + rehydrated task/change history), flip to `running`, record the resume event, and delegate to `startManagedSession` with the continuation prompt; wrap start in the durable best-effort safety net.

## 4. Boot wiring

- [x] 4.1 In `src/backend/app.ts`, after `reconcileOrphanedWorktrees()`, enumerate `interrupted` goals, resolve each goal's adapter from saved provider settings, and call `resumeInterruptedGoal` (best-effort, non-blocking boot; a goal with no resolvable adapter is left `interrupted`).

## 5. End-to-end reconcile-then-resume (TDD)

- [x] 5.1 Write a failing integration test for the full boot sequence: a goal left `running` with an in-flight worker attempt is taken `running` → `interrupted` (3a reconcile) → `running` (3b resume) with a fresh continuation-driven supervisor session, using mock adapter fixtures.

## 6. Verify and commit

- [x] 6.1 Run focused tests for the changed files; all green.
- [x] 6.2 Run `npm run typecheck` and the full `npm test` suite; all green.
- [x] 6.3 Live smoke per CLAUDE.md: with a mock adapter, seed a durably `interrupted` goal, boot the backend (or invoke resume), and confirm via the durable timeline that the goal returns to `running` under a continuation-started session. Record findings in this change's `verification.md`.
- [x] 6.4 Commit the task group with an imperative message naming the change (`resume-interrupted-goals`).
