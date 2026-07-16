## Verification log

All paths below are disposable test paths unless explicitly identified. The incident database and its Goal/provider state have not been opened for write.

### Environment and baseline

- Worktree: `/Users/tf00185088/Desktop/agent-loop-worktrees/fix-managed-task-split-lineage`
- Branch/base: `fix/managed-task-split-lineage` at `cf6a64ce661c516de8f6c5ddbe515ce9791a0646`
- A local `node_modules` symlink points at the dependency tree in the main checkout because this worktree has no lockfile and sandboxed network installation cannot complete. It is untracked and will be removed before final status verification.
- Baseline `npm run typecheck`: PASS.
- Baseline `npm test`: 495 passed, 2 failed, 59 cancelled. The failing groups require opening a local listener; the sandbox returned `EPERM: operation not permitted 127.0.0.1`. No timeout, assertion, or test exclusion was changed.

### Groups 1–2: split lineage RED/GREEN

RED command:

```text
node --import tsx --test src/runtime/agent-session/task-registry.test.ts src/persistence/managed-task-repository.test.ts src/runtime/agent-session/managed-completion-evaluator.test.ts src/runtime/agent-session/change-registry.test.ts
```

Pre-fix result: 53 tests, 41 passed, 12 failed. Expected failures proved:

- eligible parent stayed `failed`/`rejected` instead of `split`;
- invalid siblings, early/self/missing/wrong-change parents, and late descendants were accepted;
- archive reported an undelivered parent while completion ignored the same non-split parent/child graph;
- split-without-child, cross-change, missing-parent, and cycle diagnostics were absent.

Additional direct-review RED:

```text
node --import tsx --test --test-name-pattern='direct narrowing follows' src/runtime/agent-session/task-registry.test.ts
```

Result before the minimal state fix: 1 failed with `Managed parent task task-1 is already accepted.` This proved that two substantive review rejections left the in-memory task falsely `done`, preventing direct narrowing without a redundant delegation.

GREEN commands:

```text
npm run typecheck
node --import tsx --test src/runtime/agent-session/task-registry.test.ts src/persistence/managed-task-repository.test.ts src/runtime/agent-session/managed-completion-evaluator.test.ts src/runtime/agent-session/change-registry.test.ts src/runtime/agent-session/agent-session-manager.test.ts
git diff --check
```

Result: typecheck PASS; 108/108 tests PASS; diff check PASS. The deterministic manager regression observed two substantive rejections, direct child registration, ordered archive of `change-one` and `change-two`, next-change activation, satisfied reassessment, Goal completion, and no `supervisor.continuations_exhausted` event.

Transactional fault coverage includes a child criterion insert failure and a `managed_task.lineage_split` audit insert failure. In both cases the parent status and complete child/event set rolled back. Exact child-set replay is a no-op; late child mutation and an active parent fail closed.

### Commit environment blocker

The required group commit was attempted only after strict OpenSpec validation, typecheck, 108 focused tests, and diff check were green:

```text
openspec validate fix-managed-task-split-lineage --strict
git diff --check
git add <approved change artifacts>
git commit -m "Add managed task split lineage proposal" ...
```

OpenSpec validation passed. Git could not create the linked-worktree metadata lock outside the writable root:

```text
fatal: Unable to create '/Users/tf00185088/Desktop/agent-loop/.git/worktrees/fix-managed-task-split-lineage/index.lock': Operation not permitted
```

No file was staged or committed. Commit checkboxes remain unchecked until the environment grants write access to the linked-worktree Git metadata.

### Group 3: migration and restart

The file-backed migration fixture covers fresh baseline, already-valid lineage, two provable incident-shaped parents (including a terminal blocked Goal), ambiguous chronology, equal-size child contract, cross-change ownership, active parent, and a cycle. The named migration reported two bounded repairs and six bounded ambiguous parent diagnostics. Only the two proven parent `status` values changed; terminal Goal/run/session snapshots and raw events were identical before/after, and `PRAGMA foreign_key_check` returned no rows.

Fault injection results:

- `before_row_update`: repair and marker both absent after failure; normal reopen repaired once.
- `before_marker_insert`: repair and marker both rolled back; normal reopen repaired once.
- `after_commit`: repair and marker were both durable despite the simulated process failure; normal reopen was a no-op.
- split transaction committed before cache refresh: reopen restored one `split` parent, one child, exact counts/contracts/change ownership, and one lineage event; exact replay created no duplicate.
- interrupted-Goal rehydration read failure: zero provider starts and Goal remained `interrupted`; normal retry used a continuation prompt containing the durable task history.

Required focused command was run twice from separate fresh disposable paths:

```text
node --import tsx --test src/persistence/database.test.ts src/persistence/managed-task-repository.test.ts src/runtime/agent-session/supervisor-state-rehydration.test.ts src/runtime/agent-session/managed-runtime-restart.test.ts
```

Both runs: 38/38 PASS. `npm run typecheck` and `git diff --check`: PASS. Group 3 commit remains unchecked solely because the linked-worktree Git metadata lock is outside the sandbox writable roots.

### Group 4: backend-owned archive and restart reconciliation

RED restart command:

```text
node --import tsx --test --test-name-pattern="restart (reconciles a pending archive intent|verifies a committed archive operation)" src/runtime/agent-session/managed-runtime-restart.test.ts
```

Pre-reconciliation result: 0/2 passed. Both cases observed zero archive reconciliation calls, proving that neither a pending write-ahead intent nor a committed-final-event/cache-refresh window was processed before provider resume.

GREEN evidence now covers:

- candidate rejection for archive additions/modifications, main-spec mutations, and active-change deletion, while active spec and production/test files remain allowed;
- one fixed write-ahead identity committed before workspace mutation;
- archive operation status plus one `change.archived` event finalized transactionally and idempotently;
- source-present and exact-target-present replay, committed-event/cache repair, and one next-change activation;
- rollback at `before_final_event`/`after_final_event`, plus resume windows after intent, move/Git work, and durable finalization;
- durable `undelivered_task`, `invalid_split_lineage`, `unmerged_changes`, and `archive_state_ambiguous` blocker events with bounded logical IDs and sanitized workspace paths.

Focused command:

```text
node --import tsx --test src/runtime/agent-session/openspec-workspace-service.test.ts src/runtime/agent-session/managed-delivery-service.test.ts src/persistence/managed-change-archive-repository.test.ts src/runtime/agent-session/change-registry.test.ts src/runtime/agent-session/agent-session-manager.test.ts src/runtime/agent-session/supervisor-state-rehydration.test.ts src/runtime/agent-session/managed-runtime-restart.test.ts
```

Result: 96/96 PASS. `npm run typecheck`: PASS. Group 4 implementation checkboxes are complete; the group commit checkbox remains unchecked because the previously recorded linked-worktree metadata lock is still outside the writable sandbox.

### Group 5: explicit offline operator recovery

Initial RED:

```text
node --import tsx --test src/runtime/agent-session/managed-goal-recovery.test.ts
```

Result before implementation: module-not-found for `managed-goal-recovery.js`. The first completed fixture then proved dry-run stability, authorized adoption, and transactional lifecycle requirements before broader failure cases were added.

GREEN recovery coverage:

- twice-identical read-only plans with byte-for-byte database hash preservation;
- exact plan digest, byte-identical verified SQLite backup, and database/workspace/Goal-bound stopped-backend evidence;
- fail-closed terminal-reason, active run/pipeline, invalid lineage, migration ambiguity, multiple archive, invalid artifact, manifest mismatch, and incoherent Git provenance cases;
- transaction faults after authorization, archive operation, final event, and Goal update with zero partial rows;
- explicit adoption records authorization, fixed committed archive operation, and one `change.archived` event without filesystem/Git mutation;
- only `blocked → interrupted` and `completed_at → NULL`; historical run/session/task/event evidence remains, and repeated apply is idempotent;
- the recovery command starts zero sessions; later normal resume verifies the durable archive and starts one continuation prompt containing durable `task-one` history;
- separate dry-run/apply copies leave the sanitized incident-shaped source database hash and Git snapshot unchanged.

Focused command excluding the independent pre-existing Goal-order test:

```text
node --import tsx --test src/runtime/agent-session/managed-goal-recovery.test.ts src/persistence/database.test.ts src/persistence/managed-change-archive-repository.test.ts src/runtime/agent-session/managed-runtime-restart.test.ts
git diff --check
```

Result: 29/29 PASS; diff check PASS. `npm run typecheck`: PASS.

The separately required `src/persistence/goal-repository.test.ts` originally had a nondeterministic fixture: two Goals could share one millisecond timestamp, production correctly ordered that tie by random UUID descending, while the test expected insertion order. After Hermes isolated it as the only normal-host full-suite failure, a bounded fixture-only correction injected `2026-06-15T08:00:00.000Z` and `2026-06-15T08:00:01.000Z`. The ordered `[second.id, first.id]` assertion remains unchanged, so the test now deterministically expresses newest-first ordering without changing or bypassing the production `created_at DESC, id DESC` contract.

Fresh RED/GREEN evidence:

```text
for i in {1..20}; do node --import tsx --test src/persistence/goal-repository.test.ts; done
```

- before the fixture change: 14 processes passed and 6 failed; every failure showed only the two random UUIDs reversed;
- after the fixture change: 20/20 processes passed.

The required group 5 command was then rerun:

```text
node --import tsx --test \
  src/runtime/agent-session/managed-goal-recovery.test.ts \
  src/persistence/goal-repository.test.ts \
  src/persistence/database.test.ts \
  src/persistence/managed-change-archive-repository.test.ts \
  src/runtime/agent-session/managed-runtime-restart.test.ts
```

Result: 33/33 PASS. Task 5.6 is complete under CTY's explicit instruction that Hermes will create the group commits in the normal host environment; this Codex sandbox did not commit.

### Group 6: continuation-policy compatibility

No production continuation-policy code was changed. Focused compatibility tests pin:

- one initial supervisor turn plus exactly the configured two continuations;
- rejection reason consumption/reset, producing `control_rejected` followed by `completionless_exit`;
- `maxSupervisorContinuations: 2`, `completionRequestEvaluated: false`, and exact terminal text `Supervisor reached 2 continuations without a completion signal`;
- durable event order `managed_task.lineage_split` → accepted child projection → `change.archived(change-one)` → `change.activated(change-two)` with no exhaustion.

Command:

```text
node --import tsx --test --test-name-pattern="continuation accounting preserves|durable split lineage, not continuation policy" src/runtime/agent-session/agent-session-manager.test.ts
```

Result: 2/2 PASS; `npm run typecheck`: PASS. Task 6.3 remains unchecked because Git cannot acquire the linked-worktree metadata lock recorded above.

### Final design sanity check

The approved fail-closed design remains internally consistent after implementation:

- the first valid child set is the only operation that can atomically freeze a parent as `split`;
- archive and Goal completion consume the same durable recursive lineage projection and retain separate non-lineage gates;
- archive ownership is backend-only, every attempted outcome is durable, and restart reconciliation adopts no unowned target;
- migration and operator recovery preserve ambiguous incident history instead of inferring intent; and
- no production continuation-policy source, setting, counter, reset, or terminal message was changed.

A late restart RED exposed one necessary refinement within the approved archive contract: after change one archives, later work can advance `HEAD` before a terminal archive operation is replayed. Exact equality with the recorded archive SHA would then reject a valid history. The focused test `terminal archive replay accepts a later descendant HEAD while preserving the committed archive SHA` failed before the change. The minimal GREEN behavior requires the recorded archive SHA to be an ancestor of current `HEAD`, keeps the recorded SHA as the durable archive identity, and still rejects unrelated/divergent history. Targeted workspace tests and typecheck pass.

### Group 7: deterministic staged pipeline and fault windows

The product-level regression `deterministic staged pipeline survives split-cache and archive-move restarts then completes` uses a file-backed disposable SQLite database, the production manager/repositories, and deterministic runtime roles. It records two substantive parent review rejections, atomically registers one narrower child, accepts and delivers that child, closes/reopens after the split commit/cache-loss window, closes/reopens again after the fixed archive target has moved but before SQLite finalization, then performs real Worker/Judge task attempts for the second change and completes reassessment.

Targeted command:

```text
node --import tsx --test --test-name-pattern="deterministic staged pipeline survives" src/runtime/agent-session/managed-runtime-restart.test.ts
```

Result: PASS. Durable assertions prove one `managed_task.lineage_split`, one committed child delivery, exactly two committed archive operations/events (`change-one`, `change-two`), one `change-two` activation, zero incident-loop rejection reasons (`not active`, `Reassessment requires`, `existing worker result`), zero `supervisor.continuations_exhausted`, final Goal status `completed`, and exact terminal message `Staged restart pipeline completed`. The split-cache, archive-move, before/after-final-event, and post-finalization/cache-activation fault suites also prove no duplicate child, archive, event, delivery, activation, or provider resume.

Final focused command:

```text
node --import tsx --test \
  src/domain/agent-runtime-control-plane.types.test.ts \
  src/persistence/database.test.ts \
  src/persistence/managed-task-repository.test.ts \
  src/persistence/managed-change-archive-repository.test.ts \
  src/runtime/agent-session/task-registry.test.ts \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/runtime/agent-session/managed-delivery-service.test.ts \
  src/runtime/agent-session/change-registry.test.ts \
  src/runtime/agent-session/openspec-workspace-service.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/supervisor-state-rehydration.test.ts \
  src/runtime/agent-session/managed-runtime-restart.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts
node --import tsx --test src/persistence/goal-repository.test.ts
```

Result at that stage: 177/177 PASS plus 3/3 Goal repository PASS. The later repeated-run evidence above exposed and removed the Goal test's same-timestamp nondeterminism with a fixture-only clock.

### Incident-copy recovery evidence

Original read-only evidence hashes were rechecked:

```text
latest-goal.json   8c043dfd46407271ce9216fe91726e2fd0f16a2bc5c9fd681720a9549e495e83
latest-events.json b1acd0fd73b91ecfe2c92897da330520bab17408edea68f34fa768eb58af22d0
e2e.sqlite         704647ce0e52d93b8586f3e2c8a82ff0cd49482ef7a9ded027ad3dc43c9508bc
```

`/tmp/agent-loop-incident-copy-20260717.sqlite` was created as a disposable copy and opened through the new migration path. Its resulting hash was `ea3998936542d8938e790f143569c8743c299c62fe5d3f68740d3ccebd9e88a2`. The recovery dry-run command was:

```text
node --import tsx scripts/recover-managed-goal.ts \
  --database /tmp/agent-loop-incident-copy-20260717.sqlite \
  --workspace /tmp/agent-loop-block-rerun-cf6a64c/run \
  --goal 9a21f43e-1a89-43ef-9bd7-aae4a099034f
```

It returned `eligible: false`, plan digest `52f1a4f1460f69a829fb56c681ff2914b7401a21e38f7093ea089ef031fdda4b`, no actions, and blocker `invalid_lineage:parent_not_split:impl-task-definition-core,repair-task-definition-core-verification`. Both the original and copy hashes were identical before/after dry-run. This is the required fail-closed result for ambiguous real history; no original database, Goal, session, provider, or workspace state was changed.

### Real Codex provider attempt

The local binary is `codex-cli 0.144.1`. A disposable `CODEX_HOME` copied only authentication/configuration inputs, so the original provider state was not written. The production manager and real Codex adapter were invoked from a fresh Goal workspace and fresh SQLite database:

```text
CODEX_HOME=/tmp/agent-loop-real-codex-home \
  node --import tsx /tmp/agent-loop-real-e2e-20260717-run2/run-real-e2e.ts
```

The provider acceptance could not reach the first Supervisor control action because this sandbox cannot resolve/reach the Codex service. This is an external environment blocker, not an accepted E2E result:

- root: `/tmp/agent-loop-real-e2e-20260717-run2`
- Goal: `1f841cf6-b04f-4670-bbc1-c1d94fc570b0`
- terminal status: `failed`
- counts: 7 events, 1 session, 0 delegations, 0 managed tasks, 0 planned changes, 0 archives, 0 exhaustion events
- exact terminal message: `Reconnecting... 2/5 (stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known)`
- SQLite SHA-256: `02a0ab98281e97e72d9a78ab8b2896f50b4625eea43a8a97f6fb927c6094d154`
- workspace `HEAD`: `7898a0f5fff8d673598526f86321e58b518dddb7`; status clean
- timeline: `run.started` → `session.started` → `session.state_changed` → thread progress → turn progress → `command.failed` → terminal `error`

The direct CLI probe independently exhausted WebSocket retries with DNS lookup failure and its HTTPS fallback failed to send the request. Task 7.4 remains unchecked because no real Supervisor/Worker/review_merge lineage, archive, or completion evidence exists.

### Final local verification matrix

```text
npm run typecheck
```

PASS (`tsc --noEmit`, exit 0).

```text
npm test
```

Fresh result after the Goal fixture correction in this restricted Codex sandbox: exit 1, 601 tests, 540 passed, 2 failed, 59 cancelled. The corrected `creates, lists, and gets persisted goals` test passes. The only failing top-level suites are the same sandbox listener limitation recorded at baseline: `Backend API` and `E2E: create goal, start goal, read event timeline`; their hooks report `listen EPERM: operation not permitted 127.0.0.1`. No timeout, assertion, listener binding, or exclusion was relaxed.

Hermes independently ran the complete gate in a normal host environment where both listener suites pass. Before this fixture correction that run was stable at 600/601 with this Goal-order test as the sole failure. Combined with the modification's 20/20 isolated GREEN result, 33/33 group-focused result, this sandbox full run proving the corrected Goal test passes with no new non-listener failure, and fresh `npm run typecheck` exit 0, task 7.2 is complete under its documented platform-specific evidence clause. This record does not claim that the restricted sandbox's full command exited 0.

Final artifact commands:

```text
openspec validate fix-managed-task-split-lineage --strict
openspec status --change fix-managed-task-split-lineage
openspec instructions apply --change fix-managed-task-split-lineage --json
git diff --check
```

Results at that checkpoint: strict validation PASS; OpenSpec reports 4/4 artifacts complete; apply instructions reported 28/36 tasks complete; diff check PASS. After the bounded Goal fixture follow-up, tasks 5.6 and 7.2 are complete, yielding 30/36. Task 7.6 and the remaining group-commit tasks remain unchecked because the linked-worktree Git metadata lock cannot be created in this sandbox. No alternate index, commit, push, or archive workaround was used.

### Hermes independent-review repair cycle

This cycle rechecked every review candidate against production code and the approved delta specs instead of treating the review as authoritative. Findings 1–10 were reproduced as valid defects. Finding 11 was valid as a test-evidence/honesty concern: earlier fake archive services did not prove real Git fault windows, while this repository has no backend process-lock primitive. The bounded repair adds real Git move/commit/index-lock tests and binds stopped evidence to the database digest and workspace HEAD; it does **not** claim an OS process lock. Finding 12 was already correct and remains unchanged: `goal-repository.test.ts` alone injects distinct timestamps, while production ordering stays `created_at DESC, id DESC`.

New RED evidence:

```text
node --test --import tsx \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/persistence/database.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts
```

- 36 tests: 31 passed, 5 failed.
- Direct cross-Goal child and post-freeze descendant tamper both lacked `invalid_split_lineage`.
- Distinct timestamps in manager order (`parent update < child commit < supervisor.task_list`) left two provable parents unrepaired.
- Recovery ignored the migration's real `ambiguousParents` structure.

```text
node --test --import tsx src/runtime/agent-session/openspec-workspace-service.test.ts
```

- 10 tests: 8 passed, 2 failed.
- An unrelated staged file was included by the unscoped archive commit.
- Pending reconciliation returned current descendant `HEAD` instead of the unique earlier archive commit.

Each following isolated regression was also observed RED before its production fix:

```text
node --test --import tsx --test-name-pattern='turns an archive service exception' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 0/1 PASS: no durable archive failure event

node --test --import tsx --test-name-pattern='post-registration cache refresh failure' \
  src/runtime/agent-session/managed-runtime-restart.test.ts
# 0/1 PASS: Goal remained running and the committed list was reported rejected

node --test --import tsx --test-name-pattern='real pending-delivery reset fails' \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts
# 0/1 PASS: reset_failed was ignored and Goal became resumable interrupted

node --test --import tsx --test-name-pattern='idempotent recovery replay fails closed' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 0/1 PASS: an authorization row bypassed tampered postconditions

node --test --import tsx --test-name-pattern='recovery apply requires exact digest' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 0/1 PASS: stale stopped-database evidence was accepted

node --test --import tsx --test-name-pattern='repairs only provable historical split lineages' \
  src/persistence/database.test.ts
# 0/1 PASS: migration did not consume managed_task.lineage_split evidence
```

The corresponding GREEN behavior is:

- durable lineage checks joined parent Goal ownership directly and compares every `split` parent's current descendants with the one unambiguous frozen child set from `managed_task.lineage_split` and/or migration `frozenLineages`;
- the same tampered frozen-lineage database fixture now fails both `evaluateManagedCompletion` and the manager's archive gate with `frozen_child_set_mismatch`;
- migration accepts both runtime split evidence and historical task-list evidence, requires `parent threshold/update <= first child registration <= audit event`, records frozen child IDs, and writes/reads `ambiguousParents` while retaining `ambiguousTasks` compatibility;
- archive preparation requires a clean workspace, staging/commit is scoped to the exact source and dated target, and the unscoped resulting commit diff must be one coherent rename; reconciliation proves exactly one archive commit between `preArchiveHead` and `HEAD`, preserving that SHA across later unrelated descendant commits and rejecting zero, conflicting/multiple, or recorded-SHA mismatch;
- prepare, filesystem/Git, finalization, and restart-reconciliation exceptions become sanitized durable blocked/failed outcomes; a real `.git/index.lock` verifies the Git failure path;
- post-registration cache failure stalls the session, fails the run, records `managed_task.cache_refresh_failed`, leaves the Goal `interrupted`, and stops event consumption for restart rehydration;
- a real pending-delivery reset failure caused by `.git/index.lock` records `recovery.reconciliation_blocked`, moves the Goal to `blocked`, and starts no provider;
- recovery replay revalidates Goal lifecycle, exactly one authorized committed archive operation, archive identity/SHA, exactly one archive event, and authorization/operation cross-links; five tamper/partial-restore scenarios are read-only and fail closed;
- stopped evidence now binds `databaseSha` and `workspaceHead` in addition to Goal and paths. This detects stale evidence but remains an operator attestation, not a process lock.

Real Git/restart coverage added during this review:

```text
node --test --import tsx src/runtime/agent-session/openspec-workspace-service.test.ts
# 12/12 PASS

node --test --import tsx --test-name-pattern='real Git archive move' \
  src/runtime/agent-session/managed-runtime-restart.test.ts
# 1/1 PASS; after-move and after-commit restart windows converged,
# locked-after-move durably blocked before provider start
```

Final affected-suite command after all review repairs:

```text
node --test --import tsx \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/persistence/database.test.ts \
  src/persistence/managed-task-repository.test.ts \
  src/persistence/managed-change-archive-repository.test.ts \
  src/runtime/agent-session/openspec-workspace-service.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/managed-runtime-restart.test.ts \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts
```

Result: 139/139 PASS, exit 0.

```text
npm run typecheck
```

Result after the production repairs: PASS, exit 0.

```text
npm test
```

Latest restricted-sandbox result: 612 tests, 551 passed, 2 failed, 59 cancelled, exit 1. Both failed top-level suites are still the listener-permission cases (`Backend API` and API E2E); all new review regressions and the fixture-only Goal ordering test pass. Hermes' normal-host listener rerun remains the authoritative host gate. This cycle did not run or claim a successful real-provider large Goal E2E; task 7.4 remains unchecked for Hermes.

Final review-cycle gates before dependency-symlink removal:

```text
npm run typecheck
# PASS, exit 0

openspec validate fix-managed-task-split-lineage --strict
# Change 'fix-managed-task-split-lineage' is valid, exit 0

openspec status --change fix-managed-task-split-lineage
# spec-driven, repo-local, 4/4 artifacts complete, exit 0

git diff --check
# no output, exit 0

pwd && git branch --show-current && git rev-parse HEAD
# /Users/tf00185088/Desktop/agent-loop-worktrees/fix-managed-task-split-lineage
# fix/managed-task-split-lineage
# cf6a64ce661c516de8f6c5ddbe515ce9791a0646
```

The temporary untracked `node_modules` symlink was then removed. Final `git status --short --untracked-files=all` contains only the approved change's production/test/script/OpenSpec files plus the preserved fixture-only Goal test correction; it contains no `node_modules` entry, generated dependency tree, SQLite database, provider state, archive, or commit artifact. No commit, push, OpenSpec archive, provider invocation, Goal mutation, or non-test runtime SQLite write occurred in this review cycle.

After the review-hardening task group was recorded, `openspec instructions apply --change fix-managed-task-split-lineage --json` reported 34/40 complete and six remaining: five commit-bearing group tasks (commits are prohibited in this review turn) plus the Hermes-owned real-provider E2E. A final strict validation, `git diff --check`, full untracked-file status, and explicit `node_modules` absence check all exited 0.

### Second independent-review fail-closed repair cycle

All four candidates were checked against production control flow and the approved fail-closed contract. Each was valid and was reproduced without touching a non-test runtime database, provider, Goal, or external workspace.

RED evidence:

```text
node --import tsx --test --test-name-pattern='repairs only provable historical split lineages' \
  src/persistence/database.test.ts
# 0/1 PASS. goal-post-evidence-child was incorrectly repaired to split even though
# child-before-evidence=t3, matching task-list evidence=t5, and child-after-evidence=t6.

node --import tsx --test --test-name-pattern='missing a checkpoint or reconciler' \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts
# 0/3 PASS (two failing subtests plus parent). Both checkpoint-missing and
# reconciler-missing cases became interrupted rather than blocked.

node --import tsx --test --test-name-pattern='lacks prepareArchive' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 0/1 PASS. Database-backed mode called the legacy archive service once; expected zero.

node --import tsx --test --test-name-pattern='revalidates the authorized archive workspace' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 0/4 PASS (three failing subtests plus parent). Deleted target, modified manifest,
# and unrelated dirty state all returned idempotent=true.
```

The restart and replay parameterized tests were split into named subtests before the final RED rerun so one failure could not hide later cases. Production was temporarily restored to the exact original fail-open branches for those isolated commands and immediately returned to the reviewed implementation before GREEN and aggregate verification.

GREEN behavior and isolated evidence:

- Split migration still requires the parent threshold/update to precede the earliest child, and now independently requires every frozen child creation timestamp to be no later than the matching evidence. The late-child fixture remains `rejected` with `ambiguous_chronology` and is absent from `frozenLineages`.
- Restart records `pending_delivery_checkpoint_missing` or `pending_delivery_reconciler_unavailable`, leaves the Goal `blocked`, records no `recovery.reconciled`, and starts no provider. Existing real reset failure remains `pending_delivery_reset_failed`.
- A database-backed archive without `prepareArchive` records `change.archive_blocked` / `archive_capability_unavailable`, invokes no legacy archive, creates no archive operation, emits no `change.archived`, and activates no next change. The explicitly database-less manager fixture continues to cover the legacy compatibility path.
- Recovery replay now verifies the exact active source and dated target identity, one matching archive directory, source-absent/target-present topology, clean Git status, current filesystem manifest digest, and the recorded coherent rename commit/SHA/pre-head/tree digest. Deleted, modified, and unrelated-dirty real Git fixtures fail closed without changing SQLite.

```text
node --import tsx --test --test-name-pattern='repairs only provable historical split lineages' \
  src/persistence/database.test.ts
# 1/1 PASS

node --import tsx --test --test-name-pattern='missing a checkpoint or reconciler' \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts
# 3/3 PASS (two subtests plus parent)

node --import tsx --test --test-name-pattern='lacks prepareArchive' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 1/1 PASS

node --import tsx --test --test-name-pattern='revalidates the authorized archive workspace' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 4/4 PASS (three subtests plus parent)
```

Final affected-suite command:

```text
node --import tsx --test \
  src/persistence/database.test.ts \
  src/persistence/managed-task-repository.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/openspec-workspace-service.test.ts \
  src/runtime/agent-session/managed-runtime-restart.test.ts \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts \
  src/runtime/agent-session/supervisor-state-rehydration.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 133/133 PASS, exit 0

npm run typecheck
# PASS (`tsc --noEmit`), exit 0
```

Latest full-suite result after the final test structure and production restoration:

```text
npm test
# 620 tests; 559 passed, 2 failed, 59 cancelled; exit 1
```

The two failed top-level suites remain `Backend API` and `E2E: create goal, start goal, read event timeline`. A direct rerun of `src/backend/api.test.ts` and `src/backend/e2e.test.ts` reproduced `listen EPERM: operation not permitted 127.0.0.1` in both `before` hooks. No assertion, timeout, exclusion, continuation policy, or production ordering contract was relaxed, and every non-listener test passed. The fixture-only monotonic clock correction in `goal-repository.test.ts` remains intact.

This cycle did not run or claim the real-provider large Goal E2E; task 7.4 remains Hermes-owned and unchecked. No commit, push, OpenSpec archive, provider invocation, or external Goal/runtime state mutation was performed.

Final local gates for this cycle:

```text
openspec validate fix-managed-task-split-lineage --strict
# Change 'fix-managed-task-split-lineage' is valid, exit 0

openspec status --change fix-managed-task-split-lineage
# spec-driven, repo-local, 4/4 artifacts complete, exit 0

git diff --check
# no output, exit 0

git status --short --untracked-files=all
# only the existing approved change implementation/tests/script/OpenSpec artifacts
# plus the preserved goal-repository fixture correction; no node_modules or SQLite files
```

The temporary `node_modules` symlink was removed before these gates. Task 9.5 is complete under the documented listener-only environment exception; commit-bearing tasks and task 7.4 remain unchecked.

### Third independent-review durable proof repair cycle

All four candidates were independently traced through production code and reproduced. All four were valid:

1. `evaluateDurableManagedTaskLineage` and recovery consumed split-lineage evidence but not `managed-task-frozen-contract-repair-v1.details.ambiguousTasks`, so accepted/PASS data could hide an explicitly ambiguous historical contract.
2. archive preparation checked the source digest before move, while the final Git proof checked only coherent path renames; a high-similarity content mutation injected immediately before `git add` was committed and returned success.
3. restart treated a missing `prepareArchive` capability as an early success when an active database-backed change had no archive operation, then started the provider.
4. pending-delivery reconciliation used ordinary porcelain status plus `git clean -fd`, so ignored generated artifacts survived while the Goal became resumable.

RED evidence was captured before production changes:

```text
node --import tsx --test --test-name-pattern='ambiguous frozen contract|durable archive blockers' \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# exit 1. Completion returned ok=true and the archive fixture had no
# ambiguous_frozen_contract gap.

node --import tsx --test --test-name-pattern='recovery fails closed' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# exit 1. The accepted/PASS frozen-contract ambiguity case remained eligible.

node --import tsx --test --test-name-pattern='changes after preparation' \
  src/runtime/agent-session/openspec-workspace-service.test.ts
# exit 1. A high-similarity mutation injected immediately before git add
# returned archive ok=true; expected false.

node --import tsx --test --test-name-pattern='durable archive preparation is unavailable' \
  src/runtime/agent-session/managed-runtime-restart.test.ts
# exit 1. providerStarts was 1; expected 0.

node --import tsx --test --test-name-pattern='ignored generated artifact' \
  src/runtime/agent-session/managed-delivery-service.test.ts \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts
# exit 1. Service returned at_checkpoint instead of reset_failed and the Goal
# became interrupted instead of blocked.
```

GREEN behavior:

- One marker normalizer now reads frozen-contract `ambiguousTasks` plus split-lineage `ambiguousParents` and legacy `ambiguousTasks`. Completion and archive share `invalid_split_lineage` / `ambiguous_frozen_contract`; recovery emits `ambiguous_frozen_contract:<taskIds>` and retains `ambiguous_migration:<taskIds>` compatibility.
- `archive-manifest.ts` defines one canonical relative-path/content digest for the active source, dated target, and Git commit tree. Archive execution rechecks the moved target before staging, after staging, and checks both current target and the uniquely selected commit tree immediately before success. Operator replay calls the same `proveArchiveManifestIdentity` helper.
- Database-backed restart now distinguishes “no operation” from “no durable capability.” The latter durably records `change.archive_blocked` / `archive_capability_unavailable`, marks the Goal blocked, and returns before provider start. Database-less legacy archive behavior remains unchanged.
- The supervisor workspace is treated as non-disposable: reconciliation does not run `git clean -fdx`. It preserves the explicit protected ignored roots `.env`, `.worktrees`, `node_modules`, and `package-lock.json`; any other ignored path returns `reset_failed`, is not deleted, and becomes a durable non-resumable recovery blocker. Disposable child worktrees remain owned by whole-worktree removal.

Isolated GREEN commands all exited 0:

```text
node --import tsx --test --test-name-pattern='ambiguous frozen contract' \
  src/runtime/agent-session/managed-completion-evaluator.test.ts
# 1/1 PASS

node --import tsx --test --test-name-pattern='durable archive blockers' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 1/1 PASS

node --import tsx --test --test-name-pattern='recovery fails closed' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 1/1 PASS

node --import tsx --test --test-name-pattern='changes after preparation' \
  src/runtime/agent-session/openspec-workspace-service.test.ts
# 1/1 PASS; HEAD remained preArchiveHead and the archive commit count was zero

node --import tsx --test --test-name-pattern='durable archive preparation is unavailable' \
  src/runtime/agent-session/managed-runtime-restart.test.ts
# 1/1 PASS; providerStarts=0 and no archive operation/recovery.resumed event

node --import tsx --test --test-name-pattern='ignored generated artifact|protected ignored supervisor inputs' \
  src/runtime/agent-session/managed-delivery-service.test.ts
# 2/2 PASS

node --import tsx --test --test-name-pattern='ignored generated artifact' \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts
# 1/1 PASS; ignored file retained on disk, Goal blocked, providerStarts=0
```

Final affected suites:

```text
node --import tsx --test \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts \
  src/runtime/agent-session/openspec-workspace-service.test.ts \
  src/runtime/agent-session/managed-runtime-restart.test.ts \
  src/runtime/agent-session/managed-delivery-service.test.ts \
  src/runtime/agent-session/reconcile-interrupted-goals.test.ts
# 133/133 PASS, exit 0

npm run typecheck
# PASS (`tsc --noEmit`), exit 0
```

Full-suite attempt:

```text
npm test
# 626 tests; 565 passed, 2 failed, 59 cancelled; exit 1

node --import tsx --test src/backend/api.test.ts src/backend/e2e.test.ts
# exit 1; both before hooks reproduced
# Error: listen EPERM: operation not permitted 127.0.0.1
```

The only failing top-level suites remain the restricted-sandbox listener suites (`Backend API` and API E2E). No timeout, assertion, exclusion, product ordering, or continuation policy was changed. This cycle did not run or claim the real-provider large Goal E2E; task 7.4 remains Hermes-owned and unchecked. No commit, push, OpenSpec archive, provider invocation, external Goal/runtime mutation, or non-test SQLite write occurred.

Final gates after removing the temporary host `node_modules` symlink:

```text
openspec validate fix-managed-task-split-lineage --strict
# Change 'fix-managed-task-split-lineage' is valid, exit 0

openspec status --change fix-managed-task-split-lineage
# spec-driven, repo-local, 4/4 artifacts complete, exit 0

git diff --check
# no output, exit 0

test ! -e node_modules && test ! -L node_modules
# PASS; no dependency symlink/tree remains in the worktree

pwd && git branch --show-current && git rev-parse HEAD
# /Users/tf00185088/Desktop/agent-loop-worktrees/fix-managed-task-split-lineage
# fix/managed-task-split-lineage
# cf6a64ce661c516de8f6c5ddbe515ce9791a0646
```

`git status --short --untracked-files=all` lists only the existing approved change implementation/tests/script/OpenSpec artifacts and the preserved fixture-only Goal ordering correction, plus the new `archive-manifest.ts`; it contains no `node_modules`, SQLite, archive, provider-state, or generated dependency entry. Task 10.5 is complete under the documented listener-only exception; the five commit-bearing tasks and Hermes-owned task 7.4 remain unchecked.

### Final frozen-contract enforcement-bound repair cycle

The release-blocker claim was reproduced against the actual marker writer and all three consumers. `repairFrozenManagedTaskContracts` counted the full ambiguity set but wrote only `sortedAmbiguousTasks.slice(0, 50)`, while `loadManagedTaskMigrationAmbiguities` read only that bounded array. An accepted/PASS task at identity 51 therefore produced no lineage gap, the active-change archive gate did not block, and offline recovery returned eligible.

RED evidence captured before production changes:

```text
node --import tsx --test --test-name-pattern='keeps complete frozen-contract enforcement identity beyond bounded migration diagnostics' \
  src/persistence/database.test.ts
# 0/1 PASS, exit 1
# TypeError: Cannot read properties of undefined (reading 'length')
# ambiguousTaskCount=51 and ambiguousTasks.length=50, but no complete enforcement field existed.

node --import tsx --test --test-name-pattern='51st frozen-contract|legacy truncated frozen-contract' \
  src/runtime/agent-session/managed-completion-evaluator.test.ts
# 0/2 PASS, exit 1
# both accepted/PASS fixtures returned actual ok=true; expected false.

node --import tsx --test --test-name-pattern='durable archive blockers expose undelivered and invalid-lineage task ids' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 0/1 PASS, exit 1
# the 51st identity produced no ambiguous_frozen_contract completion/archive gap.

node --import tsx --test --test-name-pattern='recovery fails closed for terminal, execution, lineage, archive, artifact, digest, and Git ambiguity' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 0/1 PASS, exit 1
# the 51st frozen-contract case returned eligible=true; expected false.
```

GREEN behavior:

- New initialized-repair markers keep `ambiguousTasks` capped at 50 for human diagnostics and persist every sorted identity in `ambiguousTaskEnforcementIds`; `ambiguousTaskCount` must agree with that complete set.
- The shared reader consumes the complete set without applying the 20-task human rendering bound to enforcement. Completion renders at most the existing bounded diagnostics, while change archive selection also checks the complete per-Goal task set so a later ambiguous task cannot bypass a different change's gate.
- A new complete marker blocks only named Goals/tasks. The legal-Goal control fixture remains `{ ok: true, gaps: [] }`.
- An already-written v1 marker with `ambiguousTaskCount > ambiguousTasks.length` and no complete set cannot identify omitted owners. Completion and every change archive fail closed with sanitized `ambiguous_frozen_contract`; recovery reports `ambiguous_frozen_contract:global`. Non-truncated v1 and zero-ambiguity/fresh-baseline markers retain scoped behavior.

Isolated and affected GREEN evidence:

```text
node --import tsx --test --test-name-pattern='keeps complete frozen-contract enforcement identity beyond bounded migration diagnostics' \
  src/persistence/database.test.ts
# 1/1 PASS, exit 0; count=51, human diagnostics=50, complete enforcement=51,
# identity bounded-contract-goal:ambiguous-051 present only in enforcement, accepted/PASS row preserved,
# PRAGMA foreign_key_check=[]

node --import tsx --test --test-name-pattern='51st frozen-contract|legacy truncated frozen-contract' \
  src/runtime/agent-session/managed-completion-evaluator.test.ts
# 2/2 PASS, exit 0

node --import tsx --test --test-name-pattern='durable archive blockers expose undelivered and invalid-lineage task ids' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 1/1 PASS, exit 0; complete identity blocks task implementation and legacy truncation blocks globally

node --import tsx --test --test-name-pattern='recovery fails closed for terminal, execution, lineage, archive, artifact, digest, and Git ambiguity' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 1/1 PASS, exit 0; both identity 51 and legacy global cases remain ineligible/read-only

node --import tsx --test \
  src/persistence/database.test.ts \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts \
  src/runtime/agent-session/managed-runtime-restart.test.ts
# 114/114 PASS, exit 0

node --import tsx --test --test-name-pattern='manager completes a restarted broad staged ledger' \
  src/runtime/agent-session/managed-runtime-restart.test.ts
# 1/1 PASS, exit 0 after its exact migration-details fixture added ambiguousTaskEnforcementIds: []

npm run typecheck
# PASS (`tsc --noEmit`), exit 0
```

Full-suite attempt after the restart fixture correction:

```text
npm test
# 629 tests; 568 passed, 2 failed, 59 cancelled; exit 1
# failed top-level suites: Backend API and E2E: create goal, start goal, read event timeline
# both before hooks: listen EPERM: operation not permitted 127.0.0.1
```

No product assertion, timeout, continuation policy, Goal ordering, or test exclusion was changed. The only non-listener full-suite assertion initially exposed by the new marker field was an exact restart-fixture schema comparison; it now asserts the new empty enforcement array explicitly and passes. This cycle did not run or claim the Hermes-owned real-provider large Goal E2E. No commit, push, OpenSpec archive, provider invocation, external Goal/runtime state mutation, or non-test SQLite write occurred.

Final local gates for this cycle:

```text
openspec validate fix-managed-task-split-lineage --strict
# Change 'fix-managed-task-split-lineage' is valid, exit 0

openspec status --change fix-managed-task-split-lineage
# spec-driven, repo-local, 4/4 artifacts complete, exit 0

git diff --check
# no output, exit 0

test ! -e node_modules && test ! -L node_modules
# PASS; temporary host dependency symlink removed

pwd && git branch --show-current && git rev-parse HEAD
# /Users/tf00185088/Desktop/agent-loop-worktrees/fix-managed-task-split-lineage
# fix/managed-task-split-lineage
# cf6a64ce661c516de8f6c5ddbe515ce9791a0646
```

The final untracked-file audit contains only the existing approved change's source/tests/script/OpenSpec artifacts and the preserved Goal-ordering fixture correction. It contains no dependency tree/symlink, SQLite database, archive output, provider state, or generated runtime Goal state. Task 11 is complete under the documented listener-only exception; the five commit-bearing tasks and Hermes-owned task 7.4 remain unchecked.

### Invalid frozen-contract marker-details repair cycle

The final narrow claim was reproduced at the actual marker loader. `schema_migrations` still contained the `managed-task-frozen-contract-repair-v1` row, but `parseJsonObject` returned `null` for both malformed JSON and valid JSON that was not an object. The loader then used `?? null`, making that state indistinguishable from an absent row; `frozenContractMigrationAmbiguityForGoal` consequently returned `global: false`.

RED evidence before the production change:

```text
node --import tsx --test \
  --test-name-pattern='present frozen-contract markers with invalid details|absent and valid frozen-contract marker forms' \
  src/runtime/agent-session/managed-completion-evaluator.test.ts
# 9 tests; 6 passed; 3 failed; exit 1
# malformed JSON and JSON array both returned completion ok=true; five valid/absent controls passed.

node --import tsx --test \
  --test-name-pattern='durable archive blockers expose undelivered and invalid-lineage task ids' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 8 tests; 5 passed; 3 failed; exit 1
# malformed JSON and JSON array both reached change.archive_failed instead of change.archive_blocked.

node --import tsx --test \
  --test-name-pattern='operator recovery fails closed for present frozen-contract markers with invalid details' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 3 tests; 0 passed; 3 failed; exit 1
# both invalid marker payloads returned eligible=true.
```

Production now preserves `frozenMarkerPresent` independently from parsed details and supplies it to the frozen-contract ambiguity resolver. Its only changed branch is: parsed details `null` plus marker present returns global ambiguity; parsed details `null` plus marker absent remains non-global. No split-marker parsing or general JSON parsing behavior changed. There is no bounded alternate parser, so the malformed persisted TEXT fixture represents unreadable payloads without adding a size-specific policy.

GREEN evidence:

```text
node --import tsx --test \
  --test-name-pattern='present frozen-contract markers with invalid details|absent and valid frozen-contract marker forms|legacy truncated frozen-contract|51st frozen-contract|ambiguous frozen contract migration' \
  src/runtime/agent-session/managed-completion-evaluator.test.ts
# 12/12 PASS, exit 0

node --import tsx --test \
  --test-name-pattern='durable archive blockers expose undelivered and invalid-lineage task ids' \
  src/runtime/agent-session/agent-session-manager.test.ts
# 8/8 PASS, exit 0; both invalid forms record invalid_split_lineage / ambiguous_frozen_contract,
# archiveCalls=0

node --import tsx --test \
  --test-name-pattern='operator recovery fails closed for present frozen-contract markers with invalid details|recovery fails closed for terminal, execution, lineage, archive, artifact, digest, and Git ambiguity' \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 4/4 PASS, exit 0; invalid forms report ambiguous_frozen_contract:global and database hashes remain unchanged

node --import tsx --test \
  src/runtime/agent-session/managed-completion-evaluator.test.ts \
  src/runtime/agent-session/agent-session-manager.test.ts \
  src/runtime/agent-session/managed-goal-recovery.test.ts
# 108/108 PASS, exit 0

npm run typecheck
# PASS (`tsc --noEmit`), exit 0

openspec validate fix-managed-task-split-lineage --strict
# Change 'fix-managed-task-split-lineage' is valid, exit 0

git diff --check
# no output, exit 0

test ! -e node_modules && test ! -L node_modules
# PASS; temporary host dependency symlink removed
```

Full `npm test` was NOT VERIFIED in this narrow cycle because it was not requested; the prior cycle's restricted-listener result remains recorded above. Real-provider E2E was not run or claimed and remains Hermes-owned. No commit, push, OpenSpec archive, external Goal/provider/runtime mutation, non-test SQLite write, or dependency installation occurred. Task 12 is 3/3 complete; the pre-existing commit-bearing tasks and task 7.4 remain unchecked.

### Hermes real-provider managed split acceptance run9

A fresh isolated acceptance run used the production manager and real Codex Supervisor, Worker, and `review_merge` adapters. The harness altered neither Judge output nor durable state. It injected an A1-only candidate defect after each of the first two designated parent Workers completed and before their terminal events reached the manager; A2 remained passing. The acceptance-only red test used `src/real-split-target.acceptance.ts`, outside the ordinary `*.test.ts(x)` fixed-validation set, and a baseline full-suite preflight passed before the manager started.

```text
fixture: /tmp/agent-loop-real-e2e-20260717-run9
goal: efe715f6-82c4-4580-8915-12e2b1c5df7d
process exit: 0
database integrity: ok
foreign-key violations: 0
database SHA-256: 920a23c022a3220ae0065185316ae41b7eac65f882db12303ba23b64261b75b0
harness SHA-256: 32135684e2aac6d28c93256f18e36b15ced739e59f02a4ba196df212eab55f6c
```

Durable result:

- exactly one Change and three managed tasks (spec, parent, narrower child);
- parent attempted twice; both real Judges rejected A1 while A2 independently passed;
- two bounded injections preceded the two durable review decisions;
- parent became `split` and child creation, parent update, and split evidence share timestamp `2026-07-16T23:28:36.954Z`;
- child `real-split-repair-child` retained only C1, passed its real Judge, and was delivered under backend authority;
- one committed archive operation and one archive commit (`c8f64f245c1bb41159c105cf653c8879f37fa8cf`), with matching filesystem/commit-tree manifest digest;
- one `change.archived`, one satisfied reassessment, and exactly one terminal `goal.completed`;
- zero archive blockers, invalid-lineage blockers, execution errors, and continuation-exhaustion events;
- source repository and host provider inputs unchanged; all four dependency links removed; final fixture workspace clean with one registered worktree.

All machine assertions in `result.json` are `true`; `failedAssertions` is empty.

### Final Hermes release gate

```text
npm run typecheck
# PASS, exit 0

npm test
# 648/648 PASS, exit 0

openspec validate fix-managed-task-split-lineage --strict
# Change 'fix-managed-task-split-lineage' is valid, exit 0

git diff --check
# no output, exit 0

test ! -e node_modules && test ! -L node_modules
# PASS
```

`openspec validate --all --strict` reports all 18 authoritative specs valid and this change valid. Its aggregate exit remains 1 solely because four unrelated pre-existing placeholder changes (`agent-workstreams`, `delivery-verification`, `orchestration-governance`, and `plan-foundation`) contain no delta specs; this change neither modifies nor weakens them.
