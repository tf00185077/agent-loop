# Verification — per-goal-workspace

Date: 2026-07-21

## Automated evidence

- Full suite: `npm test` — **750 tests, 736 pass, 0 fail, 14 skipped**
  (pre-existing skips), duration ~64s.
- `npm run typecheck` — clean.
- New / extended suites:
  - `src/persistence/goal-repository.test.ts` — workspace defaults null and
    round-trips an explicit (spaced Windows) path.
  - `src/persistence/database.test.ts` — the `workspace` column and its position.
  - `src/backend/routes/goals-input-request.test.ts` — create validates the
    workspace: accepts an existing absolute directory, defaults null when
    omitted, rejects (400) a relative path, a non-existent path, and a file.
  - `src/runtime/agent-session/per-goal-workspace.test.ts` — a worker worktree
    is created under the goal's workspace; a null-workspace goal uses the server
    default.
  - `src/dashboard/goal-input-request-rendering.test.tsx` — goal detail shows the
    workspace, or "(server default)".

## Live smoke (real HTTP + real SQLite + production wiring)

Script: in-process `createApp` on a temp SQLite file for create/validate over
HTTP, plus a directly-driven manager with a recording worktree service to prove
where work resolves (createApp does not expose the worktree service). The
provider adapter is a scripted supervisor that dispatches one worker.

Observed output (verbatim):

```
CREATED with workspace: "C:\Users\TIM\AppData\Local\Temp\goal-scratch-HqEpaT"
REJECTED invalid workspace: "workspace must be an absolute directory path"
WORKER WORKTREE parentCwd: "C:\Users\TIM\AppData\Local\Temp\goal-scratch-HqEpaT" (== goal workspace, not the C:\server-default)
```

Covered end to end: a goal is created via the API with a temp scratch directory
as its workspace and persists it; an invalid (relative) workspace is rejected at
creation; and the worker's worktree is created under the goal's workspace rather
than the server default — the exact indirection that lets a real-agent goal
avoid dirtying the auto-agent repo's own DB.

## Load-bearing fix found during implementation

The delegation coordinator resolved its **own** global `supervisorCwd`
(`deps.supervisorCwd ?? process.cwd()`) and used it for worker and review-merge
worktrees — the precise place the dirty-DB failure occurs. Replacing the
manager's ~30 `state.supervisorCwd` reads alone would have left worker work in
the wrong directory; the coordinator now receives the per-goal resolved
workspace at each dispatch. The runtime test asserts this directly.

## Noticed but not touched

- The resolved workspace is cached per goal (immutable) and warmed at session
  start, so async continuations never hit a closed DB and hot paths avoid
  repeated reads.
- The complementary fix — excluding the runtime's own `data/auto-agent.sqlite`
  from the delivery cleanliness check so goals can run in the auto-agent repo
  itself — remains a separate change. This change lets a caller sidestep it by
  targeting a clean directory.
- Design open questions (require a git repo? a configurable server default
  workspace?) are recorded in design.md, unresolved by choice.
