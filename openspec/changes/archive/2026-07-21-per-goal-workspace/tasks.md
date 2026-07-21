# Tasks — per-goal-workspace

## 1. Domain and persistence

- [x] 1.1 Add `workspace: string | null` to `Goal` and `workspace?: string` to `CreateGoalInput`; export unchanged (TDD: type/contract)
- [x] 1.2 Add nullable `workspace` column to the `goals` table (CREATE + additive `ensureColumn` migration); repo create/read round-trip; column-order + migration tests
- [x] 1.3 Repository test: a goal created without a workspace reads back null; with one reads back the stored path

## 2. Backend resolution and validation

- [x] 2.1 Failing tests: create endpoint accepts a valid absolute existing-directory workspace; rejects (400, safe reason) a relative path, a non-existent path, and a path that is a file
- [x] 2.2 Implement workspace validation in `goals.ts` create route (absolute + `statSync().isDirectory()`); persist it via `createGoal`
- [x] 2.3 Manager: rename `state.supervisorCwd` → `state.defaultWorkspace`; add `resolveGoalWorkspace(deps, state, goalId)` = goal.workspace ?? defaultWorkspace
- [x] 2.4 Replace every `state.supervisorCwd` / `input.state.supervisorCwd` read (~30 sites: worktree parentCwd, openspec cwd, command cwd, sanitizeArchiveReason, recovery/reconciliation) with `resolveGoalWorkspace(...)`; keep behavior identical for null-workspace goals

## 3. Runtime tests

- [x] 3.1 Failing test: a goal with a workspace creates its worker worktree with that workspace as `parentCwd` (assert via the memory worktree service), and a null-workspace goal uses the default — covers the resolution swap
- [x] 3.2 Failing test: recovery/reconciliation of a workspace goal resolves to the same workspace (session.goalId path)
- [x] 3.3 Windows path with spaces round-trips through create → persist → resolve without corruption

## 4. Dashboard

- [x] 4.1 Add a Workspace field to the create-goal form; thread `workspace` through the `createGoal` api client and the `Goal` type
- [x] 4.2 Show the resolved workspace on the goal detail view; rendering test
- [x] 4.3 Surface a create-time validation error (invalid workspace) in the form

## 5. Verification and archive

- [x] 5.1 `npm test` and `npm run typecheck` green
- [x] 5.2 Live smoke: create a goal via the API with a temp scratch directory as workspace, start it (mock or scripted adapter), and confirm work resolves to that directory (worktree/command cwd) rather than the server cwd; record evidence in `verification.md`
- [x] 5.3 Update README (goal creation now takes a workspace); commit per task group throughout
