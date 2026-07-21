# Tasks — cleanliness-ignores-runtime-db

## 1. Shared cleanliness helper

- [x] 1.1 Add `src/runtime/agent-session/workspace-cleanliness.ts` with a pure `isWorkspaceStatusClean(porcelainStdout, cwd, ignoredAbsPaths)` and a `filteredStatusSummary(...)` for safe reasons; parse porcelain lines (2 status chars + path, rename `->` target), resolve to absolute against cwd, drop ignored, judge empty (TDD: failing tests first)
- [x] 1.2 Tests: clean when only the DB file/`-wal`/`-shm` changed; dirty when a real path changed (alone or alongside the DB); empty ignored set == raw emptiness; subdirectory cwd resolves paths correctly; rename lines handled
- [x] 1.3 Add `runtimeDatabaseIgnorePaths(dbPath | undefined)` helper: returns [] for undefined/`:memory:`, else the resolved absolute DB path plus `-wal`/`-shm`/`-journal`

## 2. Thread ignored paths from the manager

- [x] 2.1 Manager: compute the ignored set once from `deps.database?.name` (via `runtimeDatabaseIgnorePaths`) and pass `ignoredWorkspacePaths` into the delivery, integration, review-merge (workspace + verification), OpenSpec, and recovery calls
- [x] 2.2 Add optional `ignoredWorkspacePaths?: string[]` to each of those service inputs; default empty preserves current behavior

## 3. Apply the helper at each supervisor-workspace check

- [x] 3.1 `managed-delivery-service.ts`: replace the supervisor-workspace `status.stdout` emptiness judgments with `isWorkspaceStatusClean(...)`; dirty safe reasons use `filteredStatusSummary`
- [x] 3.2 `managed-integration-service.ts`: same for the supervisor-workspace check
- [x] 3.3 `review-merge-workspace-service.ts` and `review-merge-verification-service.ts`: same
- [x] 3.4 `openspec-workspace-service.ts`: same for its scaffold/archive cleanliness checks
- [x] 3.5 `managed-goal-recovery.ts`: same for the recovery workspace-dirty blocker
- [x] 3.6 Confirm worktree-scoped checks (worker/integration worktrees) are unaffected — the DB is never inside them, so the filter is a no-op there

## 4. Verification and archive

- [x] 4.1 `npm test` and `npm run typecheck` green
- [x] 4.2 Live smoke: in a temp git repo containing a committed `data/auto-agent.sqlite`-shaped file, dirty only that file and assert the delivery/review-merge cleanliness gate now passes, while dirtying an unrelated file still fails; record evidence in `verification.md`
- [x] 4.3 Update README (a goal may run inside the auto-agent repo; the runtime DB is excluded from cleanliness); commit per task group throughout
