# Verification — resume-interrupted-goals (Phase 3b)

## Automated tests

- `src/runtime/agent-session/supervisor-state-rehydration.test.ts` — 2/2 pass:
  - `rehydrateTaskRegistry` restores the task list structure, status (delegated vs
    pending), attempt counts, and criteria/outcomes from durable `managed_tasks`.
  - `rehydrateChangeRegistry` replays the durable `supervisor.change_plan` event +
    `change.spec_approved`/`change.archived` events into the registry (c1 archived,
    c2 specifying/active) — and a resumed supervisor re-announcing the plan is
    **rejected** (proving no re-scaffold).
- `src/runtime/agent-session/resume-interrupted-goals.test.ts` — 4/4 pass:
  - `resumeInterruptedGoal` starts a session whose prompt is a **continuation**
    ("Resumed after backend restart"), flips the goal out of `interrupted`, and
    records a durable `recovery.resumed` event.
  - a goal not in `interrupted` is not resumed.
  - a resume whose session start throws is recorded (`recovery.resume_failed`) and
    the goal is left `interrupted` for a later boot.
  - **end-to-end**: a `running` goal with a live session is taken
    `running` → `interrupted` (3a reconcile) → `running` (3b resume via a
    continuation-driven session).
- `src/persistence/goal-repository.test.ts` — new `listByStatus` returns only goals
  in the given status.
- `npm run typecheck` — clean. `npm test` — 493 pass, 0 fail, 14 skipped.

## Live smoke

The end-to-end test above IS the reconcile-then-resume smoke against real
repositories + a mock adapter (real SQLite, real registries). Additionally, a real
API boot (`node --import tsx src/backend/server.ts`, `AUTO_AGENT_PROVIDER=mock`,
`PORT=3505`) with the boot-time resume loop wired started cleanly and ran a goal to
`goal.completed`, confirming the resume loop does not regress startup.

## Scope (full 3b, Option B)

Resume covers both flat-task-list goals and change-plan goals: the change registry
is rehydrated by replaying the durable `supervisor.change_plan` +
`change.spec_approved`/`change.archived`/`change.blocked` events, so a resumed
supervisor cannot re-scaffold an existing change. Adapter resolution reuses the
saved-provider-settings path in `app.ts` (injected, codex-local, claude-local);
providers with no resolvable managed adapter leave the goal `interrupted` for a
later boot. Provider-native transcript resume remains deferred to Phase 4.
