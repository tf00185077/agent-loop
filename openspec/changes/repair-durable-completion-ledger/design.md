## Context

The durable completion gate intentionally looks beyond the aggregate `managed_tasks.status` value: a Goal completes only when leaf tasks, criteria, reviews, deliveries, integrations, and change-plan state all satisfy their contracts. The observed broad staged Goal reached eight `accepted` tasks but remained incomplete for two independent reasons.

First, change-plan handling created synthetic `spec:<changeId>` tasks with backend-authored structural criteria `S1`–`S3`. A later task-list event restated those tasks with different criteria and correctly recorded them in `ignoredCriteriaMutations`. After a backend restart, unconditional event backfill replayed those ignored definitions into the already-initialized ledger as new `UNKNOWN` criteria without recomputing the accepted task status. Second, completion evaluation scanned every historical worker result with attested files and demanded a committed delivery even when the authoritative Judge had rejected that candidate and a later retry had been accepted and committed.

SQLite remains the source of truth. The fix must preserve audit history, fail closed where provenance is ambiguous, remain compatible with existing REST and provider contracts, and avoid silently changing a terminal Goal's lifecycle. The completed `scope-managed-task-identities` change already establishes opaque internal task IDs and goal-local logical IDs; this design applies that ownership boundary to completion queries rather than reopening the identity model.

## Goals / Non-Goals

**Goals:**

- Make historical managed-task backfill a named, one-time, transactional, re-entrant migration rather than normal startup behavior.
- Preserve the first authoritative frozen criterion contract and repair replay-added criteria only when durable provenance proves they were ignored mutations.
- Define a candidate-scoped delivery obligation from authoritative Judge and delivery state.
- Allow a later accepted and committed retry to satisfy completion without delivering a previously rejected candidate.
- Scope completion evaluation to the current Goal and its internal task identity.
- Preserve existing `blocked`, `completed`, `failed`, and `cancelled` Goal lifecycle state during migration.
- Provide test-first coverage and a product-level restart/retry verification reproducing the observed failure shape.

**Non-Goals:**

- Automatically resume, retry, unblock, or complete a terminal Goal.
- Delete raw events, worker result summaries, delegation requests, or Judge review audit records.
- Redesign task identity, review roles, provider control blocks, REST payloads, change archival, or dashboard presentation.
- Infer `PASS` from worker prose, test claims, accepted task status, or migration heuristics.
- Add distributed migration coordination, multi-user tenancy, or an operator repair API in this change.

## Decisions

### Use named transactional schema migrations

Add a small `schema_migrations` ledger keyed by a stable migration name and carrying `applied_at` plus bounded diagnostic details. Two independent migrations are recorded:

1. a legacy managed-task backfill that runs only when pre-initialization schema inspection proves the managed-task ledger did not exist; and
2. a frozen-contract repair that examines already-initialized ledgers for the known replay corruption.

Migration effects and their marker commit in one SQLite transaction. A crash rolls both back; a reopen observes the marker and performs no work. Fresh databases create the final schema and record the legacy baseline without replaying events. This is preferred over running idempotent-looking `INSERT OR IGNORE` statements on every startup because those statements are not semantically idempotent when later events contain rejected contract mutations. It is preferred over a single `PRAGMA user_version` integer because named migrations make the legacy backfill and targeted repair independently auditable in databases that currently all report version zero.

### Derive frozen-contract provenance before repairing rows

For each affected task, the repair computes an authoritative contract from durable creation history:

- backend-created synthetic spec tasks use the earliest accepted `supervisor.change_plan.specTasks` contract;
- ordinary tasks use the earliest accepted task-list entry that created the task; and
- persisted worker-delegation acceptance is corroborating evidence, not authority to replace an earlier frozen contract.

A task-list entry whose task ID appears in that event's `ignoredCriteriaMutations` cannot introduce or replace criteria. The repair removes a criterion only when its ID/text is absent from the proven authoritative contract and its presence is attributable to replay of such an ignored event. Attempt-scoped criterion-result rows for removed definitions are deleted first to preserve foreign keys. Raw task-list events, delegation acceptance JSON, result summaries, and review decision JSON remain unchanged as historical evidence of what the buggy runtime observed; authoritative projection uses the repaired criterion table.

If the authoritative source or mutation provenance is ambiguous, the migration leaves the rows untouched, records a durable migration diagnostic, and preserves fail-closed completion. It never guesses a contract or outcome. An accepted task whose remaining authoritative criteria are not all `PASS` is likewise reported as unresolved rather than silently normalized.

Alternative considered: delete every `UNKNOWN` criterion on an accepted task. Rejected because legitimate historical criteria may still require review, and aggregate acceptance is exactly the state that proved inconsistent in the incident.

### Preserve terminal Goal lifecycle while repairing subordinate ledger state

The contract repair may correct managed-task criteria for a terminal `blocked` Goal when provenance is conclusive, but it does not update the Goal status, terminal timestamps, runs, sessions, continuations, or historical events. Migration diagnostics live in the migration ledger rather than fabricating a new supervisor decision. A user or operator must later invoke an explicitly authorized recovery path to re-evaluate or retry that Goal.

This separates data correctness from lifecycle authority. Automatically completing a previously blocked Goal would bypass the requirement for a new completion evaluation; automatically resuming it could create provider work at startup without user intent.

### Project delivery obligations from authoritative candidate state

Introduce an evaluator projection whose unit is a reviewed candidate, identified by Goal, internal task ID, worker attempt, optional integration attempt, and reviewed candidate identity.

A delivery obligation exists only when:

- the worker has backend-attested workspace changes;
- a valid authoritative Judge decision accepts the exact candidate; and
- the candidate remains the current delivery-authorized work rather than a rejected, blocked, malformed, abandoned, or superseded historical candidate.

The obligation is satisfied only by a matching committed delivery. An accepted current candidate with no committed delivery remains a gap. A Judge-rejected candidate creates no obligation because applying it is forbidden. When a later attempt is accepted and committed for the same task, earlier terminal attempts no longer create completion gaps, although their reviews and evidence remain queryable. Candidate-bound integration review and delivery identity continue to be enforced.

Alternative considered: require a terminal delivery row for every attested attempt, including rejected attempts. Rejected because it contradicts the Judge gate and makes a normal reject-then-retry sequence impossible to complete.

### Make all evaluator queries Goal scoped

Completion evaluation begins from tasks owned by the requested Goal and carries both `goal_id` and the task's opaque internal ID through attempt, review, integration, and delivery joins. A logical task ID alone is never sufficient. This prevents a same-named attempt in another Goal from appearing active or undelivered in the current Goal.

This complements, rather than duplicates, `scope-managed-task-identities`: repository identity is already goal-local, while the completion evaluator still has legacy queries that compare only the logical delegation `task_id`.

### Distinguish rejected completion requests from absent completion signals

A valid `managed_delegation.complete` request that fails durable gates remains a completion request. Continuation accounting may still bound repeated unsuccessful turns, but durable diagnostics and the terminal bound reason distinguish `completion request rejected with gaps` from `no completion signal emitted`. The last structured completion gaps remain available to the continuation and terminal diagnostic.

Supervisor guidance for a planned Goal also states that synthetic `spec:<changeId>` tasks and their structural contracts are backend-authored at plan acceptance; subsequent task lists announce implementation tasks and do not restate synthetic spec contracts.

## Risks / Trade-offs

- **[Historical provenance can be incomplete]** → Repair only conclusively attributable rows, persist bounded unresolved diagnostics, and leave ambiguous completion state fail closed.
- **[Removing derived criterion rows can obscure the buggy execution path]** → Preserve raw events, delegation acceptance, worker summaries, and review JSON; delete only authoritative projection rows that violate the proven frozen contract.
- **[A migration crash could replay partial repair]** → Apply repair and named marker in one transaction and verify repeat-open equality in tests.
- **[A later retry could incorrectly supersede still-current delivery work]** → Bind obligations to accepted review and exact candidate/delivery identity; test pending, failed, rejected, integrated, and committed combinations.
- **[Cross-Goal joins could regress as new evaluator queries are added]** → Require Goal context in projection helpers and add two-Goal same-logical-ID tests at repository and manager levels.
- **[Blocked Goals remain blocked after their ledger is corrected]** → Treat this as intentional lifecycle safety and document the required explicit recovery step; do not make migration an execution trigger.
- **[Existing tests may encode permanent gaps for terminal failed integrations]** → Reconcile tests with the written pending-state contract before changing those cases; do not broaden this repair beyond delivery-obligation semantics without a failing product scenario.

## Migration Plan

1. Add failing fixtures for fresh, true legacy, initialized-clean, initialized-corrupt, ambiguous, and terminal-blocked databases. Capture Goal state, task contracts, review/delivery history, migration diagnostics, and `PRAGMA foreign_key_check` before implementation.
2. Add the migration ledger and pre-initialization schema detection. Mark fresh databases at baseline; run legacy event backfill exactly once only when managed tables were absent.
3. Implement the frozen-contract repair transaction and diagnostics. Verify the known ignored-mutation shape is repaired, ambiguous rows remain fail closed, raw audit records remain present, and a second reopen is byte-for-byte stable for affected authoritative rows.
4. Deploy evaluator projection changes after migration tests pass. No API or control-block migration is required.
5. Preserve terminal Goal lifecycle state. Operators may back up the database, deploy, inspect migration diagnostics, and then use a separately authorized recovery workflow if a blocked Goal should be retried.
6. Rollback restores the pre-deployment database backup together with the prior application version. Down-migrating repaired criterion projection in place is unsupported because doing so would intentionally reintroduce known corruption.

## Open Questions

None required before implementation. Ambiguous historical rows deliberately remain fail closed, and terminal Goal recovery remains an explicit operation outside this change.
