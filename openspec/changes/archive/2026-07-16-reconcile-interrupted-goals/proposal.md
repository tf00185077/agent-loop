## Why

On restart the backend force-fails every non-terminal goal
(`recoverOrphanedSessions` marks sessions/goals `failed`, "lost adapter
control"). This is blunt and lossy: a mid-flight goal is permanently killed even
though its durable state (events, managed tasks, deliveries, integrations) and
git are intact, and it leaves in-flight state inconsistent (a pending delivery
row may disagree with git; a running worker attempt is abandoned with its task
still `delegated`). This is the core crash-recovery defect. Phase 3a makes a
restart-interrupted goal reconcile into a clean, consistent, **resumable** state;
Phase 3b (separate) then resumes execution.

## What Changes

- Replace the force-fail-all recovery with a per-goal reconciler. For each goal
  that has a non-terminal session at startup, the backend:
  - **Reconciles pending deliveries against git** using the Phase 1 primitive:
    for each `listPendingDeliveries(goalId)` row, call
    `reconcilePendingDelivery({ supervisorCwd, checkpointHead })` to reset the
    supervisor workspace to the recorded clean checkpoint (never double-applying,
    never shipping unvalidated code), recording a durable event.
  - **Interrupts in-flight worker attempts** (delegation requests in
    `requested`/`accepted`/`running`) durably and **resets their managed task to
    a re-dispatchable `registered` state**, preserving the frozen contract and
    the durable retry/narrowing counts. An interrupted attempt is NOT counted as
    a substantive rejection and does NOT consume the narrowing budget.
  - Continues to interrupt non-terminal integrations (existing behavior).
- Introduce goal status **`interrupted`** — "reconciled after a restart, not
  currently executing, resumable" — replacing the force-fail `failed` for these
  goals. `interrupted` is **non-terminal** (its worktrees are not reclaimed by
  the Phase 2 terminal-goal pass; Phase 3b will pick it up). `GoalStatus` is a
  TEXT column with no CHECK constraint, so this is a domain type-union addition,
  not a schema migration.
- Record a durable recovery event per goal summarizing what was reconciled
  (deliveries reset, attempts interrupted, tasks reset) as evidence for Phase 3b
  and audits.

Non-goals (explicitly deferred, do NOT touch here):

- **Resuming/continuing** the supervisor — restarting a session with a
  re-projected continuation prompt and rehydrating in-memory `SupervisorState`.
  3a leaves the goal cleanly `interrupted` and stops. That is Phase 3b.
- Provider session resume (Phase 4).
- Any change to delivery mechanics, worktree reclaim, or the completion gate.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-runtime-control-plane`: add a requirement that a restart-interrupted
  goal is reconciled (pending deliveries reset to their checkpoint, in-flight
  worker attempts interrupted, tasks reset to re-dispatchable) and left in a
  durable non-terminal `interrupted` state, instead of force-failed.

## Impact

- `src/runtime/agent-session/agent-session-manager.ts` — rewrite
  `recoverOrphanedSessions` into the per-goal reconciler.
- `src/domain/status.types.ts` — add `interrupted` to `GoalStatus`.
- `src/persistence/managed-task-repository.ts` — a task reset (to `registered`,
  counts preserved) and reuse of `listPendingDeliveries`; possibly a helper to
  list in-flight worker attempts for a goal.
- `src/persistence/runtime-repositories.ts` — reuse `detachDelegationRequest`
  for interrupting attempts; a query for in-flight worker attempts per goal.
- Dashboard renders the new `interrupted` status string (no behavioral UI work).
- No SQLite schema change.
