## Context

Phase 3a leaves crash-interrupted goals in a clean, durable `interrupted` state.
The machinery to continue a supervisor already exists: `startManagedSession`
accepts a `prompt` override (falling back to a bootstrap prompt), the in-session
continuation builds `buildSupervisorPrompt({ phase: { kind: "continuation" },
managedTaskContext: projectManagedTaskContext(...), taskHistory, changeHistory })`,
and `runSessionEvents` drives the loop. Adapter resolution lives in the runtime
layer (`app.ts` / `createRuntimeFromSavedProviderSettings`). The gap is that the
in-memory `SupervisorState` task/change registries start empty on a fresh
process, and nothing triggers resume at boot.

## Goals / Non-Goals

**Goals:**

- Resume `interrupted` goals at boot via a fresh session + projected continuation
  prompt, flipping them back to `running`, with durable evidence.
- Rehydrate the per-goal task/change registries from durable rows so the resumed
  session's continuation and enforcement reflect the ledger.

**Non-Goals:**

- Provider-native transcript resume (Phase 4). 3a reconcile / delivery / worktree
  / completion mechanics are unchanged.

## Decisions

**1. A `resumeInterruptedGoal` manager entry point, orchestrated from `app.ts`.**
Resume needs an adapter, and adapter resolution already lives in the runtime
layer. So `app.ts`, after `recoverOrphanedSessions()` +
`reconcileOrphanedWorktrees()`, lists `interrupted` goals, resolves each goal's
adapter from saved provider settings (the same path a normal run uses, keyed by
the goal's recorded provider), and calls
`agentSessionManager.resumeInterruptedGoal({ goalId, providerId, modelLabel,
adapter })`. Rehydration must touch the manager's private `SupervisorState`, so it
lives inside the manager.

**2. Reuse `startManagedSession` with a continuation prompt.** `resumeInterruptedGoal`
rehydrates the registries, flips the goal to `running`, builds the continuation
prompt from the rehydrated registries + `projectManagedTaskContext`, records a
durable `recovery.resumed` event, and delegates to `startManagedSession({ ...,
prompt: continuationPrompt })`. Passing `prompt` bypasses the bootstrap builder so
prior work is not re-decomposed, while reusing all existing run/session/adapter/
`runSessionEvents` wiring. Alternative rejected: duplicating the session-start
machinery — unnecessary and drift-prone.

**3. Rehydrate registry structure from durable rows; keep the durable projection
authoritative.** Rebuild the task registry via `registerTaskList` from
`managedTaskRepo` rows (id, title, acceptance criteria, parentTaskId, changeId)
and the change registry via `registerPlan` + replay of the durable merged/active
change state. This makes `taskHistory`/`changeHistory` non-empty and restores the
enforcement caches (task dedup, one-active-change). Per-task/criterion *status*
in the prompt comes from `projectManagedTaskContext` (durable), which stays the
source of truth; rehydration repopulates working caches, it does not re-derive
outcomes the ledger already owns.

**4. Best-effort and bounded.** A resume that throws is caught and recorded
durably (consistent with the Phase 0 safety net) and the goal is left
non-`running` (e.g. reverted to `interrupted` or `blocked`), never silently
retried in a tight loop. A goal that resumes and crashes again is reconciled +
resumed on the next boot; the existing completionless-continuation cap already
bounds a goal that cannot make progress to `blocked`, so resume adds no new
unbounded loop.

## Risks / Trade-offs

- [Rehydration diverges from the true durable state] → Mitigated by keeping
  `projectManagedTaskContext` (durable) authoritative for status; rehydration only
  restores list/plan structure. Tests assert the resumed prompt is a continuation
  carrying the projection.
- [Resuming a goal whose provider is no longer configured] → Resolve best-effort;
  if no adapter resolves, record durably and leave the goal `interrupted` (a later
  boot with provider configured can resume it). No crash.
- [Double-resume / resuming an already-running goal] → `resumeInterruptedGoal`
  guards on `status === "interrupted"` and flips to `running` before starting, so
  a second pass is a no-op.

## Migration Plan

No data migration. Additive boot behavior after recovery. Rollback removes the
`app.ts` resume loop; goals then remain `interrupted` (3a's state) rather than
resuming — still safe, just not auto-continued.

## Open Questions

- Should resume be throttled/staggered when many goals are `interrupted` at once?
  Deferred: v1 resumes sequentially at boot; revisit if a large backlog makes boot
  slow. Sequential resume matches the one-active-child, local single-user model.
