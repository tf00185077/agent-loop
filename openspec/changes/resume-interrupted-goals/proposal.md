## Why

Phase 3a reconciles a restart-interrupted goal into a clean, resumable
`interrupted` state, then stops — nothing restarts the supervisor, so the goal
sits idle until a human intervenes. This change (Phase 3b) resumes interrupted
goals at startup, finally delivering the roadmap's headline: "loop until
deliverable" survives a backend restart. It is the payoff that completes the
core crash-recovery work.

## What Changes

- At startup, after `recoverOrphanedSessions` + `reconcileOrphanedWorktrees`,
  the backend enumerates goals in `interrupted` status and resumes each: flips
  the goal back to `running` and starts a fresh managed supervisor session driven
  by a **continuation** prompt projected from durable state — not a bootstrap
  prompt that would re-decompose the goal from scratch.
- The continuation prompt is built the same way the in-session continuation is:
  `buildSupervisorPrompt({ goal, phase: { kind: "continuation", observation },
  managedTaskContext: projectManagedTaskContext(...), taskHistory, changeHistory })`.
  Because the in-memory `SupervisorState` registries start empty on a fresh
  process, the backend **rehydrates the per-goal task and change registries from
  durable rows** before building the prompt, so `taskHistory`/`changeHistory`
  reflect the ledger and the resumed session enforces against the same state it
  had before the crash. The durable projection stays authoritative; rehydration
  only repopulates the working caches.
- Resume is orchestrated from the layer that already resolves provider adapters
  (`app.ts` / the saved-provider-settings path), which calls a new manager entry
  point `resumeInterruptedGoal({ goalId, providerId, modelLabel, adapter })`.
- A durable resume event is recorded per goal. Resume is **best-effort**: a
  resume that fails to start is recorded durably (Phase 0 safety net) and leaves
  the goal visibly non-running; a goal that resumes and crashes again is simply
  reconciled + resumed on the next boot, bounded by the existing
  completionless-continuation cap so a goal that cannot make progress eventually
  `blocked`s rather than spinning forever.

Non-goals (explicitly deferred, do NOT touch here):

- Provider-native session resume / replaying the provider transcript (Phase 4).
  3b resumes via a fresh session + re-projected continuation prompt, which is
  provider-agnostic and is the correctness floor.
- Any change to 3a's reconcile, delivery mechanics, worktree reclaim, or the
  completion gate.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `supervisor-goal-orchestration`: add a requirement that a durably `interrupted`
  goal is resumed on startup by rehydrating its task/change registries from
  durable rows and starting a fresh supervisor session with a projected
  continuation prompt, flipping the goal back to `running`.

## Impact

- `src/backend/app.ts` — after recovery, enumerate `interrupted` goals, resolve
  each goal's adapter from saved provider settings, and call
  `resumeInterruptedGoal`.
- `src/runtime/agent-session/agent-session-manager.ts` — new
  `resumeInterruptedGoal` entry point + registry rehydration from durable rows;
  reuse the existing continuation-session machinery and `runSessionEvents`.
- `src/persistence/goal-repository.ts` (or a query) — list goals by
  `interrupted` status.
- No SQLite schema change.
