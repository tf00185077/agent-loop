# Verification — cleanliness-ignores-runtime-db

Date: 2026-07-21

## Automated evidence

- `npm run typecheck` — clean.
- New suite: `src/runtime/agent-session/workspace-cleanliness.test.ts` (6) — clean
  when only DB files changed; dirty for a real path (alone or with the DB); empty
  ignored set == raw emptiness; subdirectory cwd resolves correctly; rename lines;
  `runtimeDatabaseIgnorePaths` handles absent/in-memory.
- Touched service suites all green (delivery, integration, review-merge workspace
  + verification, openspec-workspace, managed-goal-recovery, delegation-coordinator).
- Full suite: `npm test` — see the run tally below.

## Live smoke (real git, not a mocked runner)

Script: a real temp git repo with a committed `data/auto-agent.sqlite`; the actual
`createGitReviewMergeWorkspaceService` (which shells out to real `git status`).

Observed output (verbatim):

```
DB-ONLY DIRTY → gate reports CLEAN, checkpoint recorded: ebc7ad1fda
WITHOUT IGNORE → gate reports dirty (old behavior preserved): "Supervisor workspace is dirty:  M data/auto-agent.sqlite\n?
REAL CHANGE + DB DIRTY → gate reports dirty, names only: "Supervisor workspace is dirty:  M src.ts"
PASS: cleanliness smoke complete
```

Covered against real git: dirtying only the runtime DB (and a `-wal` sidecar)
makes the review-merge cleanliness gate report the workspace clean and record a
checkpoint; passing no ignore list reproduces the old dirty verdict; dirtying an
unrelated tracked file makes the gate report dirty and its safe reason names only
that file, never the database.

## Scope note

All workspace-cleanliness gates that run in the goal/supervisor workspace were
threaded: delivery (prepareCandidate, deliverCandidate, reconcile, restoreCheckpoint),
integration (prepare), review-merge (prepareReviewMerge + verifyMerged via the
delegation coordinator), OpenSpec archive (requireCleanGitWorkspace + changedGitPaths),
and operator recovery (proveArchiveGit + validateRecoveryReplayWorkspace). The ignored
set is derived once from `deps.database.name` and threaded in; worktree-scoped checks
(worker/integration worktrees, which never contain the DB) are unaffected because the
filter matches by absolute path.

## Noticed but not touched

- Hard-reset restore paths (`git reset --hard` on a workspace holding the live,
  open DB) have an OS-level open-file concern beyond cleanliness; this change only
  refines the cleanliness verdict. Running a goal on the auto-agent repo remains
  best paired with a per-goal workspace when heavy rollback is expected.
