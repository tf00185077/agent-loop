## Context

The incident Goal `9a21f43e-1a89-43ef-9bd7-aae4a099034f` reached two substantive rejections for `task-definition-core`, registered and accepted a narrower child, and still retained the durable parent as `rejected`. The task-list path currently mutates the in-memory registry before calling `ManagedTaskRepository.registerTasks`; both paths attach `parentTaskId`, but neither makes child registration transition the parent. The durable delegation gate transitions the parent to `split` only if the Supervisor redundantly delegates the exhausted parent again.

The two downstream gates then disagree. `GoalChangeRegistry.canArchive` follows descendants only when the in-memory parent status is exactly `split`; `evaluateManagedCompletion` treats every task with a child row as a non-leaf regardless of parent status. The same durable graph can therefore pass Goal completion's task closure while failing active-change archival as an undelivered parent. No later planned change, reassessment, completion request, or review request can satisfy the still-active change, so control rejections consume continuations without changing the gate.

The incident also proved a separate archive ownership gap: a Worker ran the archive operation inside its worktree, the candidate was reviewed and delivered, and the active change directory disappeared even though no durable `change.archived` event existed. `OpenSpecWorkspaceService.archiveChange` currently fails when the source is absent or the dated target already exists, so retry is not idempotent. `tryArchiveActiveChange` persists `change.archive_blocked` only for unmerged attested files; an undelivered or invalid lineage returns silently.

These are confirmed defects in split registration and archive coordination. They are not the same as `repair-durable-completion-ledger`, which repairs frozen-contract replay and candidate delivery obligations after task attempts have reached terminal dispositions. This change depends on that Goal-scoped durable projection and named migration infrastructure but does not alter its candidate rules.

## Goals / Non-Goals

**Goals:**

- Make the first accepted child set atomically establish one frozen split lineage in SQLite and the working cache.
- Give archive and Goal completion one durable, recursive, fail-closed interpretation of leaf, split, and invalid task graphs.
- Make every failed archive attempt durably diagnosable with structured, sanitized blockers.
- Prevent provider-controlled candidates from performing backend-owned OpenSpec archive/sync mutations.
- Make an interrupted backend archive operation safely retryable from a write-ahead intent without guessing filesystem or Git state.
- Repair historical parent status only when lineage provenance is conclusive; preserve ambiguous histories and terminal Goal lifecycle.
- Provide a dry-run-first, offline operator recovery path for eligible Goals already blocked by this defect.
- Prove live, restart, migration, and full staged-pipeline behavior test first.

**Non-Goals:**

- Changing the configured continuation maximum, which turns increment it, its reset semantics, or its terminal message.
- Automatically resuming, unblocking, completing, reassessing, or starting provider work during migration or ordinary reconciliation.
- Inferring semantic scope from task titles, prompts, or model prose, or repairing ambiguous historical lineage/archive state.
- Changing provider control-block or REST request shapes, introducing a provider-selected archive command, or allowing agents final Git/archive authority.
- Reopening candidate delivery-obligation, frozen-contract, task-identity, planning-epoch, or distributed-worker design.
- Archiving this OpenSpec change or implementing production behavior in the proposal phase.

## Decisions

### Treat the first child set as one atomic narrowing transition

Extract a pure narrowing validator that stages a complete state plan without mutating either registry. For every child-bearing task-list entry, it requires:

- a pre-existing parent in the same Goal and same change (including both being plan-less);
- a parent at the existing retry threshold (two substantive rejections or three attempts), not accepted or already frozen into another split;
- no active worker attempt, pending Judge review, pending delivery, or nonterminal integration for the parent;
- one or more new child logical IDs, no cycle or self-parent edge, and no existing descendants outside the submitted child set; and
- a non-empty frozen acceptance contract on every child whose criterion count is strictly smaller than the parent's contract.

SQLite registration applies the parent `split` transition, all child/criterion inserts, and a sanitized `managed_task.lineage_split` audit event in one transaction. Any invalid child or persistence failure rolls back the entire child set and parent transition. Re-announcing the exact frozen child set is an idempotent no-op; adding or replacing descendants after the split is frozen fails closed. A one-criterion parent that cannot satisfy the deterministic smaller-contract test must use the existing fail/re-plan path rather than obtain an unverifiable split.

In production durable mode, the manager persists first and then rehydrates the task cache from the committed rows before linking tasks into the change cache or acknowledging the task list. If the transaction fails, all caches and durable events remain unchanged. If persistence succeeds but cache refresh fails, the backend records `managed_task.cache_refresh_failed`, stalls the session/run, leaves the Goal `interrupted`, and requires restart rehydration; it does not misreport the committed list as rejected. The in-memory-only compatibility path applies the same pure plan by swapping a staged map only after every entry validates.

Alternative considered: mark the parent `split` when a later delegation of the exhausted parent is rejected. Rejected because it preserves the incident's dead state until an unnecessary control action occurs. Alternative considered: add a new explicit supervisor split control block. Rejected because `parentTaskId` already declares the intent and a new provider contract would be broader and easier to misuse.

### Use one durable lineage evaluator for archive and completion

Add a Goal-scoped lineage projection over durable task rows. It validates ownership, change ownership, parent existence, cycles, status/descendant agreement, and frozen descendant sets, then returns recursive leaf closures plus structured gaps. At minimum, these shapes are invalid:

- a parent with descendants whose status is not `split`;
- a `split` task with no descendants;
- a cross-Goal or cross-change edge;
- a cycle, missing parent, or descendant set that violates the frozen split evidence.

Every invalid shape returns `invalid_split_lineage` with bounded logical task IDs and a stable reason code. Valid split parents are satisfied only through all required leaf descendants. The change archive gate selects the closure for the active change and adds its merge/archive conditions; the Goal completion evaluator selects the Goal closure and adds criterion, attempt, review, delivery, integration, change, and reassessment conditions. Neither gate derives lineage from the in-memory cache.

Alternative considered: teach only `GoalChangeRegistry.canArchive` to treat any parent with children as split. Rejected because it would hide corrupt state and retain two independent definitions that can diverge again.

### Persist every archive blocker

Every backend attempt to archive an active executable change records either `change.archived`, `change.archive_failed`, or `change.archive_blocked`. A blocked event carries `changeId`, a stable blocker type such as `undelivered_task`, `invalid_split_lineage`, `unmerged_changes`, `archive_state_ambiguous`, affected logical task IDs when applicable, and a sanitized safe reason. Repeated attempts may create repeated audit events; correctness and visibility take priority over event deduplication in this repair.

The archive gate is evaluated from durable state after any task transition. In-memory change status is updated only after the final archive event commits and is reconstructable by replay after restart.

### Reserve archive-owned paths from provider candidates

Before Judge acceptance can lead to delivery, a backend validator rejects a Worker/spec-writer candidate that:

- adds, removes, or modifies anything under `openspec/changes/archive/`;
- modifies `openspec/specs/` as an archive/sync side effect; or
- deletes files from the active planned change, including its `.openspec.yaml` and required artifacts.

Spec writers may add or modify files inside their active change; implementation workers may change production/test files. Only an internal backend archive operation may move the active change and synchronize main specs. The rejected candidate remains durable evidence but cannot be delivered. Prompt guidance is updated only as documentation; the reserved-path validator is the enforcement boundary.

Alternative considered: trust the Supervisor prompt to tell workers not to archive. Rejected because the incident shows prompt-only ownership is not enforcement.

### Write archive intent before filesystem and Git side effects

Add a `managed_change_archive_operations` ledger keyed by Goal/change with source path, chosen dated target path, validated artifact manifest digest, pre-archive workspace HEAD, status, bounded diagnostics, and timestamps. The backend requires a clean workspace before intent/move, writes `pending` before moving files, scopes staging/commit to the recorded source and target, and verifies that the resulting commit contains only the coherent source-to-dated-target rename. After that backend Git commit is uniquely proven between the pre-archive HEAD and current HEAD, one SQLite transaction marks the operation terminal and appends `change.archived`; only then does the cache activate the next change.

The archive manifest uses one canonical mapping of file paths relative to the active source or dated target root. The backend recomputes the target digest after the move, again after staging, and verifies both the current target and the uniquely selected commit tree against the durable digest immediately before returning success. A manifest race may leave a moved or staged workspace for reconciliation, but it cannot finalize SQLite state or activate the next change. Operator replay uses the same canonical filesystem/commit-tree proof helper.

Reconciliation uses the stored target rather than recalculating a date:

1. `pending`, source present, target absent, matching manifest and checkpoint: continue the backend move/commit.
2. `pending`, source absent, exact target present, matching manifest: finish the missing backend commit or identify exactly one coherent archive commit after the recorded checkpoint, then finalize durably; current HEAD alone is never accepted as archive identity.
3. terminal operation, exact target and digest present: idempotent no-op and replay/cache repair only.
4. source and target both present, both absent, multiple matching archives, digest/path/HEAD mismatch, or target without a matching intent: record `archive_state_ambiguous` and stop.

No automatic reconciler adopts a provider-created archive merely because its directory name looks right. That legacy case is reserved for explicit operator recovery with stronger validation.

### Repair only provable historical lineages

Add named migration `managed-task-split-lineage-repair-v1` to the existing migration ledger. It is transactional, re-entrant, and recorded as a fresh baseline on new databases. For existing rows, it marks a non-`split` parent as `split` only when durable task/event chronology proves the threshold preceded the earliest child registration and every frozen child existed no later than the matching split/task-list evidence, all descendants share Goal/change ownership, every child contract is deterministically narrower, no conflicting descendants exist, and the parent has no active/pending attempt, review, delivery, or integration state. Comparing only the earliest child against the evidence is insufficient because it could bless a later injected descendant.

Already-valid graphs are untouched. Ambiguous threshold chronology, semantic-only narrowing, cross-change edges, pending work, cycles, missing audit provenance, or physical archives without write-ahead intent remain unchanged. Bounded task IDs and reason codes are recorded in migration details, and the shared evaluator continues to fail closed. Raw events, attempts, reviews, deliveries, archive files, Goals, runs, sessions, terminal timestamps, and continuation history are not rewritten.

Human diagnostics and enforcement identity are stored separately. The frozen-contract marker retains at most 50 sorted `ambiguousTasks` for bounded rendering, while `ambiguousTaskEnforcementIds` stores the complete sorted identity set consumed by completion, archive, and recovery. The reader validates that the complete set is structurally valid and agrees with `ambiguousTaskCount`; new markers therefore block only Goals/tasks named by complete evidence. For already-written v1 markers that have `ambiguousTaskCount` greater than the bounded diagnostic array but no complete enforcement set, the omitted owners cannot be reconstructed safely, so every Goal fails closed with `ambiguous_frozen_contract` until an operator supplies separately proven repair. Non-truncated v1 markers and zero-ambiguity/fresh-baseline markers retain their prior scoped behavior.

Marker presence and marker validity are separate facts. An absent frozen-contract marker contributes no ambiguity, while a present marker whose `details` is malformed JSON or valid JSON that is not an object cannot prove any safe enforcement scope and therefore produces the same global `ambiguous_frozen_contract` fail-closed outcome at completion, archive, and recovery. A valid fresh-baseline object, valid zero-ambiguity object, task-scoped v1 object, complete enforcement object, and the legacy truncated-global case retain their existing behavior. The loader uses ordinary `JSON.parse` with no bounded/alternate parser, so malformed persisted text is the representative unreadable-payload fixture; no size-specific policy is introduced.

Migration and archive-ledger schema changes commit atomically per migration. A crash before the marker rolls back effects and marker together; reopen after success is a no-op. Rollback restores a pre-deployment database backup with the prior application version; in-place down-migration is unsupported.

### Rehydrate from durable state and recover blocked Goals explicitly

Database initialization and the lineage migration complete before any interrupted Goal is rehydrated. The cache maps durable `split` rows and descendants exactly; if a crash occurs after the SQL split transaction but before cache refresh, restart reconstructs the committed split. Archive reconciliation likewise runs before supervisor continuation and never infers success from the cache. In database-backed mode, the workspace service must expose durable archive preparation; absence of that capability records `archive_capability_unavailable` and never downgrades to the legacy archive path. The database-less compatibility path may retain the legacy operation because it has no durable ledger to finalize.

Provide a local, offline operator command/service whose default is read-only dry-run. Apply mode requires the backend to be stopped, a verified backup path, the selected Goal ID, and the exact digest printed by the dry-run. Stopped-backend evidence binds the selected Goal and paths to the exact pre-apply SQLite digest and current workspace HEAD so stale evidence fails closed. Eligibility requires a terminal `blocked` Goal with a continuation-exhaustion event, no active child/session or pending task pipeline state, no ambiguous migration diagnostics, a valid shared lineage projection, and change/workspace evidence consistent with one recovery plan.

Pending-delivery checkpoint proof also inspects ignored paths. The supervisor workspace is non-disposable, so recovery never runs `git clean -fdx`; `.env`, `node_modules`, `.worktrees`, and `package-lock.json` are retained as explicit protected local inputs. Any other ignored path makes exact checkpoint proof fail closed and keeps the Goal blocked. Disposable child worktrees remain owned by the existing whole-worktree removal path.

For the incident's source-missing/one-archive/no-intent shape, explicit recovery may adopt the archive only when there is exactly one matching dated directory, required artifacts strictly validate, its manifest matches delivered task evidence, and Git history proves one coherent archive commit. The apply transaction records an operator authorization, creates a reconciled archive operation and uniquely cross-linked `change.archived` event when needed, and moves the Goal from `blocked` to `interrupted` while clearing only its terminal timestamp. An idempotent replay revalidates the interrupted Goal, committed operation identity/SHA, unique event, both authorization/operation cross-links, exact source-to-dated-target workspace topology, current manifest digest, clean Git state, and the recorded coherent archive commit rather than trusting the authorization row alone. It does not alter task evidence, old sessions, continuation policy/configuration, or start a provider. The operator then restarts the backend; existing interrupted-Goal startup behavior creates a fresh continuation from the durable projection. If a pending delivery lacks either its recorded clean checkpoint or the reconciliation capability, or reset cannot prove that checkpoint, restart durably blocks instead of marking the Goal resumable. Any failed precondition leaves the Goal blocked and produces no partial recovery writes.

Alternative considered: let migration automatically resume repaired Goals. Rejected because startup data repair must not authorize provider work or alter a terminal lifecycle. Alternative considered: direct SQL runbooks. Rejected because they bypass invariants and cannot safely reconcile filesystem/Git evidence.

### Keep continuation policy orthogonal

No production change in this proposal touches `maxSupervisorContinuations`, completion-less/control-rejected accounting, counter reset behavior, or exhaustion wording. Regression tests pin the current behavior around the lineage repair. Whether control rejections should consume a separate budget is a future product proposal, not a hidden mitigation for this defect.

## Risks / Trade-offs

- **[Strict contract-count narrowing rejects a semantically narrower one-criterion child]** → Use the existing fail/re-plan route; do not infer semantic scope from prose. A future explicit scope schema can broaden this safely.
- **[Durable-first registration leaves the cache stale if refresh throws]** → Treat refresh failure as a visible runtime interruption; restart rehydrates from committed SQLite and must not roll back durable truth.
- **[Archive intent cannot make SQLite, filesystem, and Git one transaction]** → Use write-ahead identity/digest/checkpoint plus exhaustive fault injection at every boundary and fail closed on every unrecognized topology.
- **[Reserved paths reject an unusual legitimate worker edit]** → Keep the rule scoped to planned Goal archive/sync paths and require backend operations for those mutations; the original worker result remains auditable.
- **[Historical event chronology is incomplete]** → Leave rows unchanged with bounded migration diagnostics and operator-visible `invalid_split_lineage`; never guess.
- **[A legacy frozen-contract marker truncated the only task identity list]** → Treat the marker as globally ambiguous rather than guessing which Goal owns entries after the diagnostic bound; fresh migration markers carry a separate complete enforcement set so unaffected Goals remain eligible.
- **[A frozen-contract marker exists but its details cannot be parsed as an object]** → Preserve row presence independently from parse output and fail closed globally; do not reinterpret corruption as a missing/fresh marker.
- **[Operator recovery could revive an unrelated blocked Goal]** → Require the exact dry-run plan digest, continuation-exhaustion provenance, valid lineage, quiescent execution, backup, and coherent workspace/Git proof.
- **[Repeated archive-blocked events add timeline volume]** → Keep payloads bounded and sanitized; visibility is required for diagnosis, and deduplication can be a later observability optimization.
- **[Real provider behavior is nondeterministic]** → Prove the exact two-rejection transition deterministically at unit/manager layers, then use live Codex acceptance as an additional end-to-end contract check with durable event assertions.

## Migration Plan

1. Capture failing unit and manager regressions for the inconsistent parent/child graph, including the current archive/completion disagreement, before production changes.
2. Add the pure lineage validator/evaluator and domain gap types; make focused tests pass without wiring side effects.
3. Add transactional child registration, cache rehydration ordering, and rollback/fault tests.
4. Add the named migration and fixtures for valid, repairable incident-shaped, ambiguous, cross-change, pending-work, terminal-blocked, crash, and repeat-open databases; require clean foreign keys and unchanged terminal lifecycle.
5. Add reserved-path validation and the archive operation ledger/reconciler with fault injection before/after intent, move, Git commit, final event, and cache update.
6. Wire archive and completion to the shared durable evaluator and persist every archive blocker.
7. Add the dry-run/apply operator recovery only after migration and archive reconciliation are stable; verify an untouched copy of the incident-shaped database and workspace, never the originals.
8. Run focused suites, typecheck, full tests, migration/restart fixtures, strict OpenSpec validation, and the disposable real-provider staged-Goal acceptance.

Deployment requires a database and Goal-workspace backup. Migration runs before runtime resume and never changes Goal lifecycle. Rollback restores both backup and prior application version; an archive finalized under the new ledger is not down-migrated in place.

## Open Questions

No blocking product decision remains. Two consciously deferred questions require separate proposals: a richer explicit scope schema for one-criterion narrowing, and any redesign of supervisor continuation accounting or budget reset semantics.
