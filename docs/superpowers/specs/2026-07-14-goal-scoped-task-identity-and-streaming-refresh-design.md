# Goal-Scoped Task Identity and Streaming Refresh Design

## Problem

Managed task control blocks use human-readable keys such as `task-1`, but
SQLite currently stores that key as the global primary key of `managed_tasks`.
The bootstrap prompt also demonstrates `task-1` for every goal, so a second
goal can reliably collide with historical state from the first goal.

The dashboard already receives durable events over SSE. Relevant events bump a
snapshot refresh key, but `GoalDetail` sets its blocking `loading` state on
every refresh and replaces the current page with `Loading...`, producing a
visible flash even though usable data is already rendered.

## Goals

- Permit the same logical task key in different goals while preserving every
  existing task, criterion, attempt, review, integration, and delivery record.
- Keep LLM-facing control blocks and durable event metadata readable with local
  task keys such as `task-1`.
- Make repository lookups unambiguous and prevent accidental cross-goal reads.
- Keep current dashboard content mounted while SSE-triggered snapshots refresh
  in the background.
- Ignore stale asynchronous responses when goal selection or refresh order
  changes.

## Non-Goals

- Changing task keys within one goal after they are frozen.
- Adding parallel child execution or a new streaming protocol.
- Streaming complete SQLite snapshots through SSE.
- Deleting or rewriting user goal history beyond the required key migration.

## Data Model

`managed_tasks` will separate storage identity from the control-plane key:

```text
managed_tasks
  internal_id  TEXT PRIMARY KEY
  goal_id      TEXT NOT NULL
  task_key     TEXT NOT NULL
  ...
  UNIQUE(goal_id, task_key)
```

Existing task IDs become `task_key`. Each existing row receives a stable
internal ID during the one-time migration. New tasks receive a generated
internal ID at insertion time. Tables that currently reference
`managed_tasks(id)` will reference `internal_id` instead. Parent lineage also
uses the internal ID in storage while repository read models continue to expose
the parent's logical task key.

Delegation control blocks, events, prompts, dashboard read models, and public
domain records keep using the logical task key. They do not expose the internal
UUID.

## Migration

SQLite table replacement will run transactionally with foreign keys handled in
dependency order:

1. Create replacement task and task-dependent tables.
2. Copy existing tasks, generating one internal ID per row and retaining the
   old `id` as `task_key`.
3. Resolve parent and child-table references through the old ID-to-internal-ID
   mapping.
4. Recreate constraints and indexes.
5. Swap replacement tables into their final names.
6. Run foreign-key integrity checks before committing.

The migration must be idempotent: databases already containing
`internal_id/task_key` are left unchanged. A migration failure rolls back the
entire transaction and leaves the old schema readable.

## Repository Contract

Task operations will be goal-scoped. Lookups that currently accept only
`taskId` will accept `goalId` plus logical `taskKey`, or consume an already
resolved internal identity inside one repository transaction. Worker
delegation IDs remain globally unique and can still identify an attempt, but
the repository will verify that the delegation and task belong to the same
goal.

Registration remains idempotent within one goal: announcing `task-1` twice
returns the frozen original task. Announcing `task-1` under a different goal
creates a distinct task.

## Runtime Failure Handling

Unexpected control-event persistence failures must not leave a managed session
looking indefinitely active. The manager will persist a safe failure/stalled
outcome through its existing terminal error path after a repository exception.
The original exception remains logged server-side, while user-visible events
contain bounded safe context.

## Dashboard Refresh Model

The existing SSE stream remains the notification channel:

1. `EventTimeline` appends the durable event immediately.
2. Events that affect session/task state request a background snapshot refresh.
3. `GoalDetail` keeps the current goal and snapshot rendered during that fetch.
4. Only the first load for a newly selected goal uses blocking `Loading...`.
5. A refresh response applies only if it still belongs to the selected goal
   and is the newest request generation.
6. Background failures retain the last good content and show a non-blocking
   error message.

This avoids a second browser state machine: SSE signals that durable state
changed, and REST remains the authoritative snapshot source.

## Testing

- Migration test: an old-format database with task history upgrades without
  data loss and passes `foreign_key_check`.
- Repository test: two goals may each register `task-1`; same-goal registration
  remains idempotent and cross-goal reads are impossible.
- Runtime regression: the reported second-goal task list no longer throws.
- Failure test: an unexpected persistence error cannot leave the session
  silently running.
- Dashboard component test: initial load blocks, SSE-triggered refresh retains
  existing content, newest refresh wins, and background errors are non-blocking.
- Full test suite, typecheck, strict OpenSpec validation, and diff checks remain
  the completion gate.

## Rollout and Compatibility

The change is additive from the API and control-protocol perspective. Existing
task keys, events, prompts, and dashboard payloads retain their current shape.
Only SQLite storage identity and internal repository method signatures change.
The user's current `data/auto-agent.sqlite` is migration input and must never be
committed to Git.
