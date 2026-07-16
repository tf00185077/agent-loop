## Context

Supervisors choose readable task and change identifiers such as `task-1` and `spec:plan-foundation`. The persistence layer currently stores that logical identifier directly as `managed_tasks.id`, a database-wide primary key. Runtime registries are already per-goal and continuation projection already starts from `listForGoal(goalId)`, but repository methods such as `getTask(taskId)` discard that context. A second goal that reuses a reasonable logical name therefore collides with the first goal.

The change-plan handler also scaffolds and commits every OpenSpec change before durable synthetic-task registration. A registration exception can consequently fail the goal after repository side effects have escaped.

## Goals / Non-Goals

**Goals:**

- Make database task identity opaque and globally unique while preserving readable logical IDs at every agent and event boundary.
- Make every logical-ID lookup explicitly goal-scoped and fail closed on a mismatched goal.
- Preserve existing task, criterion, attempt, review, integration, delivery, lineage, and restart history during migration.
- Ensure accepted plan and synthetic-task persistence succeeds before OpenSpec workspace mutation begins.
- Cover both flat supervisor tasks and synthetic `spec:<changeId>` tasks.

**Non-Goals:**

- Changing supervisor control-block formats or exposing internal UUIDs to providers.
- Renaming existing logical task identifiers or change identifiers.
- Adding multi-user tenancy, distributed workers, or cross-goal task sharing.
- Changing the existing policy that a successfully accepted change plan is scaffolded and committed in a git-backed workspace.
- Redesigning unrelated run/session terminal-state reconciliation.

## Decisions

### Use an opaque database UUID plus a goal-local logical identifier

`managed_tasks.id` remains the database primary-key column but contains a backend-generated UUID. A new `logical_task_id` column stores the supervisor-facing identifier and has a unique index with `goal_id`. `parent_task_id` and all managed-task child-table foreign keys reference the UUID.

This is preferred over appending a UUID to the logical string because it keeps persistence identity out of prompts and durable event contracts. It is preferred over a composite primary key because every child relation would otherwise need to repeat `goal_id`, increasing schema and query complexity.

### Preserve logical identifiers at runtime boundaries

Domain records continue exposing `id` as the logical task identifier because task registries, prompts, control blocks, and event data use that contract. Persistence helpers retain the internal UUID privately and resolve `(goalId, logicalTaskId)` before any mutation. Repository APIs that accept a logical identifier also accept `goalId`; APIs operating from a delegation first derive and verify the delegation's goal before resolving its task.

No global `WHERE logical_task_id = ?` lookup is permitted. Continuations remain goal-scoped, so two goals may display the same logical identifier without either agent seeing the other's task.

### Migrate existing rows with an explicit old-to-new identity map

On opening a legacy database, migration adds/backfills `logical_task_id` from the legacy `id`, creates one UUID per existing task, and rewrites the managed-task primary key, self-parent reference, and every managed child-table `task_id` through the same temporary mapping in one transaction with foreign-key enforcement temporarily disabled. Foreign-key checking is re-enabled and `PRAGMA foreign_key_check` must return no violations before startup continues.

Fresh databases create the final schema directly. The migration is detected by schema shape and is idempotent; a reopened migrated database must not generate new task UUIDs.

### Persist plan intent before Git materialization

The change-plan handler first validates the plan, registers its in-memory state, and transactionally persists all synthetic tasks and the durable accepted-plan event. Only after that transaction succeeds may it scaffold changes and create scaffold commits. Each materialization result is then recorded durably. A persistence rejection produces no scaffold directory and no commit.

This ordering is preferred over a read-only collision preflight because preflight and write can diverge. SQLite and Git cannot share one atomic transaction, so durable intent is written first and any later Git failure remains observable and recoverable rather than invisible.

## Risks / Trade-offs

- **[Migration touches several related tables]** → Build a fixture containing criteria, attempts, reviews, integrations, deliveries, and parent lineage; reopen it and assert logical history plus `foreign_key_check` are unchanged.
- **[A missed unscoped lookup could cross goals]** → Change repository signatures so `goalId` is required by the type system and add a two-goal same-name regression test through the manager path.
- **[Internal UUIDs could leak into prompts or events]** → Assert projected context and durable task events contain logical IDs and never the internal UUID.
- **[Durable plan exists if Git scaffolding fails]** → Persist a visible materialization failure event and keep the plan/task state retryable; durable state is intentionally authoritative over workspace side effects.
- **[SQLite migration cannot toggle foreign keys inside a transaction]** → Toggle only around the dedicated migration, use `try/finally` to restore enforcement, and abort startup on any post-migration foreign-key violation.

## Migration Plan

1. Add migration tests that open a legacy-schema fixture and capture every logical relationship.
2. Implement schema detection and the old-ID-to-UUID rewrite, then verify `PRAGMA foreign_key_check` and reopen idempotence.
3. Update repository resolution and runtime call sites to require goal context while retaining logical IDs in public records.
4. Reorder change-plan persistence before materialization and add failure-injection coverage proving zero Git calls on persistence rejection.
5. Run focused persistence/runtime tests, the full suite, typecheck, OpenSpec validation, and a scratch-database live smoke using two goals with the same synthetic task name.

Rollback requires restoring a pre-migration database backup together with the prior application version; down-migrating task UUIDs in place is intentionally unsupported.

## Open Questions

None. Internal UUIDs, logical-ID compatibility, migration behavior, and side-effect ordering are fixed by this design.
