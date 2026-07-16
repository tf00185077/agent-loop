## Why

Managed task identifiers are currently model-authored logical names stored as database-wide primary keys. Two semantically similar goals can independently choose the same task or change identifier, causing the second goal to fail after OpenSpec scaffolding has already mutated and committed the supervisor workspace.

## What Changes

- Give every managed task an opaque UUID primary key for database identity while retaining the supervisor-authored task identifier as a goal-local logical identifier.
- Enforce uniqueness on `(goal_id, logical_task_id)` so task names may repeat across goals but never within one goal.
- Require repository and runtime lookups of logical task identifiers to carry the owning goal context; internal relations use the opaque UUID.
- Migrate existing task, criterion, review, delivery, and integration records without losing task history or changing task identifiers exposed to supervisors and durable events.
- Persist and validate an accepted change plan and its synthetic tasks before OpenSpec scaffolding may mutate or commit the workspace, and surface materialization failures durably.

## Capabilities

### New Capabilities

None. This change strengthens existing managed-task and change-plan behavior.

### Modified Capabilities

- `durable-managed-task-state`: Separate internal task identity from goal-local logical identifiers and require goal-scoped resolution across persistence, restart projection, review, integration, and delivery state.
- `goal-scale-decomposition`: Make accepted change-plan persistence and synthetic-task registration precede OpenSpec workspace materialization so a persistence rejection cannot leave scaffold commits behind.
- `supervisor-goal-orchestration`: Preserve stable logical task identifiers at the agent boundary while resolving them only within the current goal.

## Impact

- SQLite schema and migration logic in `src/persistence/database.ts`.
- Managed-task repository interfaces, queries, and tests.
- Agent-session orchestration, restart recovery, completion evaluation, and durable context projection call sites.
- Existing databases are migrated in place; provider control-block formats and user-visible logical task identifiers remain compatible.
- No new dependency, provider behavior, authentication model, or distributed-worker behavior is introduced.
