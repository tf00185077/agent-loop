## Why

Every workspace git-cleanliness gate — delivery, integration, review-merge,
OpenSpec scaffold/archive, and recovery — runs `git status --porcelain` in the
goal/supervisor workspace and fails if anything is modified. But the runtime
continuously writes its own committed database, `data/auto-agent.sqlite` (plus
`-wal`/`-shm` sidecars), into that repo. So a goal that runs inside the
auto-agent repo always sees `M data/auto-agent.sqlite`, is judged dirty, and its
task fails delivery (observed: `Supervisor workspace is dirty: M
data/auto-agent.sqlite`). The per-goal-workspace change lets a caller sidestep
this by targeting a clean directory; this change fixes it at the source so a
goal can also run inside the auto-agent repo itself.

## What Changes

- Workspace cleanliness gates SHALL disregard changes to the runtime's own
  database file and its `-wal`/`-shm`/`-journal` sidecars when judging whether a
  workspace is clean. A workspace whose only pending changes are those files
  SHALL be treated as clean.
- A single shared helper decides cleanliness from `git status --porcelain`
  output by absolute-path matching against the ignored database files, so it is
  robust to the configured DB path and to the workspace being a subdirectory;
  non-workspace worktrees (which never contain the DB) are unaffected.
- The set of ignored paths is derived from the actual runtime database path and
  threaded from the manager into the delivery, integration, review-merge
  (workspace + verification), OpenSpec, and recovery cleanliness checks.
- The behavior applies only to the runtime's own DB files; any other modified or
  untracked path still makes the workspace dirty, exactly as today.

**Non-goals**

- No change to what counts as a candidate/worker diff (worker worktrees are
  isolated and never contain the DB; their change detection is untouched).
- No gitignore change and no move of `data/auto-agent.sqlite` (it stays committed
  dev state); this only changes how cleanliness is judged.
- No new configuration surface: the ignored set is derived from the existing DB
  path, not user-set.

## Capabilities

### New Capabilities

_None — this refines existing cleanliness gates._

### Modified Capabilities

- `review-merge-worktree-gate`: the "clean supervisor workspace" requirement
  excludes the runtime's own database files from the dirtiness judgment.
- `supervisor-goal-orchestration`: a cross-cutting rule that every
  workspace-cleanliness gate ignores the runtime database files, so a goal may
  run inside the auto-agent repo.

## Impact

- New shared helper (e.g. `src/runtime/agent-session/workspace-cleanliness.ts`)
  that filters `git status --porcelain` output by ignored absolute paths.
- `managed-delivery-service.ts`, `managed-integration-service.ts`,
  `review-merge-workspace-service.ts`, `review-merge-verification-service.ts`,
  `openspec-workspace-service.ts`, `managed-goal-recovery.ts`: their supervisor-
  workspace cleanliness judgments use the helper and accept the ignored paths.
- `agent-session-manager.ts`: derive the ignored DB paths from
  `deps.database`/the resolved DB path and pass them into those services.
