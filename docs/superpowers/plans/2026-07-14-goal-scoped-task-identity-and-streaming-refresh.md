# Goal-Scoped Task Identity and Streaming Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow different goals to reuse readable task keys such as `task-1`, migrate all existing managed-task history safely, terminate sessions when runtime persistence fails, and refresh goal details from SSE without flashing away the last good snapshot.

**Architecture:** SQLite will separate an internal task UUID from the goal-local task key and all task-dependent foreign keys will point at the UUID. Repository callers will always supply `goalId` with a logical `taskId`, while domain records, control blocks, events, prompts, and dashboard payloads continue exposing only the logical key. The existing SSE stream remains a notification channel; a small reducer will keep the last good REST snapshot visible while newer snapshots load and will reject stale responses by request generation.

**Tech Stack:** TypeScript 5.7, Node.js 20 test runner, better-sqlite3, React 19, Express 5, OpenSpec CLI.

## Global Constraints

- Preserve the public `ManagedTaskRecord.id`, control-block `taskId`, event metadata, prompt text, and dashboard payload shapes as goal-local logical task keys.
- Never expose the internal task UUID outside persistence implementation details.
- Keep `UNIQUE(goal_id, task_key)` and reject duplicate logical keys only within the same goal.
- Preserve every existing task, parent link, criterion, criterion result, review, integration, and delivery row during migration.
- Keep SSE as the pushed notification path and REST snapshots as authoritative state; add no polling timer and no replacement streaming protocol.
- Block the page only while the selected goal has no usable snapshot; background refresh errors retain the last good snapshot.
- Never stage, revert, overwrite, or commit `data/auto-agent.sqlite`.
- Follow red-green-refactor for every behavior change and commit only after the focused check is green.

## File Structure

- Create `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/` for the accepted proposal, design, task checklist, and three delta specs.
- Modify `src/persistence/database.ts` to define the new schema and transactionally migrate legacy managed-task tables.
- Modify `src/persistence/database.test.ts` to verify data-preserving, idempotent migration and foreign-key integrity.
- Modify `src/persistence/managed-task-repository.ts` to resolve `(goalId, taskId)` into an internal UUID and map storage rows back to logical keys.
- Modify `src/persistence/managed-task-repository.test.ts` to cover cross-goal key reuse and scoped reads/transitions.
- Modify `src/runtime/agent-session/delegation-coordinator.ts`, `src/runtime/agent-session/agent-session-manager.ts`, and `src/runtime/agent-session/managed-context-projection.ts` to pass goal identity into repository operations.
- Modify their existing tests to cover the two-goal regression and persistence-failure lifecycle convergence.
- Create `src/dashboard/goal-detail-refresh-state.ts` and `src/dashboard/goal-detail-refresh-state.test.ts` for the pure request-generation/snapshot state machine.
- Modify `src/dashboard/GoalDetail.tsx` to use that state machine and retain the current snapshot during background refresh.

---

### Task 1: Record the Accepted Change in OpenSpec

**Files:**
- Create: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/proposal.md`
- Create: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/design.md`
- Create: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/tasks.md`
- Create: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/specs/durable-managed-task-state/spec.md`
- Create: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/specs/agent-runtime-control-plane/spec.md`
- Create: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/specs/dashboard-goal-lifecycle/spec.md`

**Interfaces:**
- Consumes: the approved design in `docs/superpowers/specs/2026-07-14-goal-scoped-task-identity-and-streaming-refresh-design.md`.
- Produces: validated requirements that Tasks 2-5 implement and Task 6 archives into the main specs.

- [ ] **Step 1: Create the OpenSpec artifacts from the approved design**

Invoke the repository's `openspec-propose` workflow with change id `fix-goal-scoped-task-identity-and-streaming-refresh`. The proposal must state the reported collision and detail-view flashing as current behavior. The delta specs must contain these exact normative outcomes:

```markdown
## ADDED Requirements

### Requirement: Managed task keys are scoped to one goal
The system SHALL store a persistence-only managed-task identity separately from the logical task key and SHALL enforce logical task-key uniqueness within one goal rather than across all goals.

#### Scenario: Two goals announce the same task key
- **WHEN** two different goals each announce a task whose logical key is `task-1`
- **THEN** the backend persists two independent managed tasks
- **AND** each goal's criteria, attempts, reviews, integrations, and deliveries remain isolated

#### Scenario: Legacy task history is migrated
- **WHEN** the backend opens a database whose managed tasks use the logical key as their primary key
- **THEN** it assigns each existing task one internal identity and preserves all task-dependent history and parent lineage
- **AND** the migrated database passes SQLite foreign-key integrity checks
```

```markdown
## ADDED Requirements

### Requirement: Runtime persistence failures terminate active lifecycle state
The runtime control plane SHALL move the affected session, run, and goal out of active state when an unexpected event-persistence error prevents safe continuation.

#### Scenario: A managed control event cannot be persisted
- **WHEN** processing an adapter event throws before its durable state can be recorded
- **THEN** the session and run become failed and the goal becomes failed
- **AND** the backend records bounded safe failure context when the event repository remains writable
```

```markdown
## MODIFIED Requirements

### Requirement: Dashboard refreshes on delegation events
The dashboard SHALL refresh authoritative managed-session snapshots when durable delegation state changes without replacing an already rendered goal detail snapshot with a blocking loading screen.

#### Scenario: Delegation state changes while detail is visible
- **WHEN** the event stream receives a managed-session refresh event for the selected goal
- **THEN** the dashboard keeps the last good goal detail visible while requesting the latest snapshot
- **AND** only the newest response for the selected goal may replace the visible snapshot

#### Scenario: Background snapshot refresh fails
- **WHEN** a refresh fails after a usable snapshot is visible
- **THEN** the dashboard retains that snapshot and shows a non-blocking error
```

- [ ] **Step 2: Validate the proposal before application code changes**

Run:

```powershell
openspec validate fix-goal-scoped-task-identity-and-streaming-refresh --strict
```

Expected: output identifies `fix-goal-scoped-task-identity-and-streaming-refresh` as valid and exits `0`.

- [ ] **Step 3: Commit the validated change artifacts**

```powershell
git add -- openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh
git diff --cached --check
git commit -m "Propose goal-scoped task identity and streaming refresh"
```

Expected: one commit containing only the OpenSpec change directory.

### Task 2: Migrate and Scope Managed-Task Persistence

**Files:**
- Modify: `src/persistence/database.ts`
- Modify: `src/persistence/database.test.ts`
- Modify: `src/persistence/managed-task-repository.ts`
- Modify: `src/persistence/managed-task-repository.test.ts`
- Modify: `src/runtime/agent-session/delegation-coordinator.ts`
- Modify: `src/runtime/agent-session/agent-session-manager.ts`
- Modify: `src/runtime/agent-session/agent-session-manager.test.ts`
- Modify: `src/runtime/agent-session/managed-context-projection.ts`
- Modify: `src/runtime/agent-session/managed-context-projection.test.ts`

**Interfaces:**
- Consumes: logical task keys from managed control blocks and `goalId` from the current session/runtime context.
- Produces: `ManagedTaskRepository.getTask(goalId, taskId)`, goal-scoped task operations, and unchanged public `ManagedTaskRecord` values.

- [ ] **Step 1: Write the failing legacy migration test**

In `src/persistence/database.test.ts`, add a fixture that creates the current legacy `managed_tasks` plus all five dependent tables, inserts a parent/child pair and one row in each history table, closes it, then opens it through `openDatabase`. Assert:

```ts
assert.deepEqual(columnNames(db, "managed_tasks").slice(0, 3), [
  "internal_id", "goal_id", "task_key",
]);
assert.equal(
  (db.prepare("SELECT COUNT(*) AS count FROM managed_tasks WHERE task_key IN ('parent', 'child')")
    .get() as { count: number }).count,
  2,
);
assert.equal(
  (db.prepare(`
    SELECT parent.task_key AS parent_key
    FROM managed_tasks child
    JOIN managed_tasks parent ON parent.internal_id = child.parent_task_id
    WHERE child.task_key = 'child'
  `).get() as { parent_key: string }).parent_key,
  "parent",
);
for (const table of [
  "managed_task_criteria",
  "managed_task_criterion_results",
  "managed_task_reviews",
  "managed_task_integrations",
  "managed_task_deliveries",
]) {
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 1);
}
assert.deepEqual(db.pragma("foreign_key_check"), []);
const firstIds = db.prepare("SELECT internal_id FROM managed_tasks ORDER BY task_key").all();
db.close();
db = openDatabase({ path: dbPath });
assert.deepEqual(db.prepare("SELECT internal_id FROM managed_tasks ORDER BY task_key").all(), firstIds);
```

- [ ] **Step 2: Run the migration test and observe the legacy schema failure**

Run:

```powershell
node --import tsx --test --test-name-pattern="migrates legacy managed-task identity" src/persistence/database.test.ts
```

Expected: FAIL because `managed_tasks` still begins with `id` and has no `task_key`.

- [ ] **Step 3: Implement the transactional identity migration**

In `src/persistence/database.ts`:

1. Import `randomUUID` from `node:crypto`.
2. Define fresh `managed_tasks` with `internal_id TEXT PRIMARY KEY`, `goal_id`, `task_key`, the existing business columns, `parent_task_id REFERENCES managed_tasks(internal_id)`, and `UNIQUE(goal_id, task_key)`.
3. Make every task-dependent `task_id` foreign key target `managed_tasks(internal_id)`.
4. Call `migrateManagedTaskIdentity(db)` after the schema creation block and before `backfillManagedTaskState(db)`.
5. Detect the legacy schema with `PRAGMA table_info(managed_tasks)`; return immediately when both `internal_id` and `task_key` exist.
6. Within one `db.transaction`, enable deferred foreign-key checking, create replacement tables, copy each legacy task using one `randomUUID()` and an old-id-to-internal-id map, resolve parent IDs and all child `task_id` values through that map, replace legacy tables in dependency-safe order, and throw if `PRAGMA foreign_key_check` returns any rows.
7. Update `backfillManagedTaskState` to insert `randomUUID(), goal_id, task_key` and to join/update by `(goal_id, task_key)` rather than a global task id.

Use one explicit invariant when resolving old IDs:

```ts
function requireMigratedTaskId(ids: Map<string, string>, legacyTaskId: string): string {
  const internalId = ids.get(legacyTaskId);
  if (!internalId) throw new Error(`Legacy managed-task reference is missing: ${legacyTaskId}`);
  return internalId;
}
```

- [ ] **Step 4: Run database tests and verify migration/data integrity**

Run:

```powershell
node --import tsx --test src/persistence/database.test.ts
```

Expected: all database tests PASS, including reopen stability and an empty `foreign_key_check`.

- [ ] **Step 5: Write failing repository tests for cross-goal reuse and isolation**

In `src/persistence/managed-task-repository.test.ts`, create two goals in one database and add:

```ts
const first = goals.create({ title: "First", description: "First goal" });
const second = goals.create({ title: "Second", description: "Second goal" });
tasks.registerTasks({ goalId: first.id, tasks: [{ id: "task-1", title: "First task", acceptance: [] }] });
tasks.registerTasks({ goalId: second.id, tasks: [{ id: "task-1", title: "Second task", acceptance: [] }] });

assert.equal(tasks.getTask(first.id, "task-1")?.title, "First task");
assert.equal(tasks.getTask(second.id, "task-1")?.title, "Second task");
tasks.transition(first.id, "task-1", "blocked", { safeSummary: "Only first" });
assert.equal(tasks.getTask(first.id, "task-1")?.status, "blocked");
assert.equal(tasks.getTask(second.id, "task-1")?.status, "registered");
assert.equal(tasks.getTask(first.id, "missing"), null);
```

Also update existing test calls so every logical-key lookup/mutation includes its fixture `goalId`.

- [ ] **Step 6: Run repository tests and observe the API/schema failure**

Run:

```powershell
node --import tsx --test src/persistence/managed-task-repository.test.ts
```

Expected: FAIL because repository methods accept only a global `taskId` and query legacy column names.

- [ ] **Step 7: Refactor the repository around internal task resolution**

Change the public interface to goal-scope every operation that starts from a logical key:

```ts
getTask(goalId: string, taskId: string): ManagedTaskRecord | null;
listCriteria(goalId: string, taskId: string): ManagedTaskCriterionRecord[];
beginAttempt(goalId: string, taskId: string, workerDelegationRequestId: string, runId?: string | null): number;
transition(goalId: string, taskId: string, status: ManagedTaskStatus, options: ManagedTaskTransitionOptions): ManagedTaskRecord;
listReviews(goalId: string, taskId: string): ManagedReviewRecord[];
listDeliveries(goalId: string, taskId: string): ManagedTaskDeliveryRecord[];
listIntegrations(goalId: string, taskId: string): ManagedTaskIntegrationRecord[];
```

Add `goalId: string` to `RecordExecutorEvidenceInput`, `RecordManagedReviewInput`, `RecordManagedDeliveryInput`, `BeginManagedIntegrationInput`, and the inline `beginReview`/`recordInvalidReview` inputs. Keep integration-attempt methods scoped by their globally unique integration id.

Use one internal resolver for all task-key entry points:

```ts
interface StoredManagedTask extends ManagedTaskRecord {
  internalId: string;
}

function getStoredTask(db: AppDatabase, goalId: string, taskId: string): StoredManagedTask | null {
  const row = db.prepare(`
    SELECT task.*, parent.task_key AS parent_task_key
    FROM managed_tasks task
    LEFT JOIN managed_tasks parent ON parent.internal_id = task.parent_task_id
    WHERE task.goal_id = ? AND task.task_key = ?
  `).get(goalId, taskId);
  return row ? mapStoredTask(row) : null;
}
```

All writes to criteria/review/integration/delivery tables use `stored.internalId`. All returned records alias or join `managed_tasks.task_key` back to the public `taskId`. When validating a delegation, verify its session goal equals `goalId` as well as its logical `task_id` equaling `taskId`.

- [ ] **Step 8: Update runtime callers and projections to pass `goalId`**

Use `parent.goalId` in `delegation-coordinator.ts`, `input.goalId` in `agent-session-manager.ts`, and the existing projection argument in `managed-context-projection.ts`. For example:

```ts
const durableTask = validation.request.taskId
  ? deps.managedTaskRepo.getTask(input.goalId, validation.request.taskId)
  : null;
const criteria = deps.managedTaskRepo.listCriteria(input.goalId, durableTask.id);
```

```ts
const reviews = repository.listReviews(goalId, task.id);
const deliveries = repository.listDeliveries(goalId, task.id);
const integration = repository.listIntegrations(goalId, task.id).at(-1);
```

- [ ] **Step 9: Add the reported two-goal runtime regression test**

In `agent-session-manager.test.ts`, start two goals against the same database with adapters that each emit a valid `managed_delegation.task_list` containing `task-1`. Assert both calls fulfill and both goal projections contain their own task:

```ts
await assert.doesNotReject(() => firstManager.startManagedSession(firstInput));
await assert.doesNotReject(() => secondManager.startManagedSession(secondInput));
assert.equal(fixture.managedTaskRepo.getTask(firstGoal.id, "task-1")?.goalId, firstGoal.id);
assert.equal(fixture.managedTaskRepo.getTask(secondGoal.id, "task-1")?.goalId, secondGoal.id);
```

Use the existing `createHandle` helper and the same valid task-list event shape used by the managed delegation tests.

- [ ] **Step 10: Run focused persistence/runtime tests and typecheck**

Run:

```powershell
node --import tsx --test src/persistence/database.test.ts src/persistence/managed-task-repository.test.ts src/runtime/agent-session/managed-context-projection.test.ts src/runtime/agent-session/agent-session-manager.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript exits `0`.

- [ ] **Step 11: Commit the goal-scoped persistence change**

```powershell
git add -- src/persistence/database.ts src/persistence/database.test.ts src/persistence/managed-task-repository.ts src/persistence/managed-task-repository.test.ts src/runtime/agent-session/delegation-coordinator.ts src/runtime/agent-session/agent-session-manager.ts src/runtime/agent-session/agent-session-manager.test.ts src/runtime/agent-session/managed-context-projection.ts src/runtime/agent-session/managed-context-projection.test.ts
git diff --cached --check
git commit -m "Fix managed task identity scope"
```

Expected: the live `data/auto-agent.sqlite` remains unstaged.

### Task 3: Converge Runtime Persistence Errors to Terminal State

**Files:**
- Modify: `src/runtime/agent-session/agent-session-manager.ts`
- Modify: `src/runtime/agent-session/agent-session-manager.test.ts`

**Interfaces:**
- Consumes: exceptions thrown while iterating or persisting runtime events.
- Produces: failed session/run/goal state plus a bounded safe error event when event persistence is still available.

- [ ] **Step 1: Write the failing lifecycle convergence test**

Wrap the fixture repository so `registerTasks` throws `new Error("synthetic persistence failure")`, emit one valid task-list control event, and assert:

```ts
await assert.rejects(
  manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "mock",
    modelLabel: "mock",
    adapter,
  }),
  /synthetic persistence failure/,
);

const session = fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id).at(-1)!;
assert.equal(session.lifecycleState, "failed");
assert.equal(fixture.runRepo.getById(session.runId)?.status, "failed");
assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "failed");
assert.ok(fixture.eventRepo.listForGoal(fixture.goal.id).some((event) =>
  event.type === "error" && event.message === "Managed runtime state could not be persisted.",
));
```

- [ ] **Step 2: Run the focused test and observe the stuck-running state**

Run:

```powershell
node --import tsx --test --test-name-pattern="persistence failure marks managed lifecycle failed" src/runtime/agent-session/agent-session-manager.test.ts
```

Expected: FAIL because the exception propagates while session/run/goal remain active.

- [ ] **Step 3: Add one terminal failure path around event iteration**

Wrap the `await runSessionEvents(...)` call in `startManagedSession` with `try/catch`. In the catch path:

```ts
const finishedAt = new Date().toISOString();
deps.agentSessionRepo.updateLifecycleState(session.id, "failed");
deps.runRepo.updateStatus(run.id, "failed", {
  finishedAt,
  error: "Managed runtime state could not be persisted.",
});
deps.goalRepo.updateStatus(goal.id, "failed", { completedAt: finishedAt });
try {
  deps.eventRepo.create({
    goalId: goal.id,
    runId: run.id,
    type: "error",
    message: "Managed runtime state could not be persisted.",
    data: {
      sessionId: session.id,
      safeReason: error instanceof Error ? error.message.slice(0, 500) : "Unknown persistence failure.",
    },
  });
} catch {
  // The terminal database updates are already attempted; preserve the original exception.
}
throw error;
```

Do not convert validation rejections into terminal errors; this catch applies only to unexpected thrown failures.

- [ ] **Step 4: Run the focused and full manager tests**

Run:

```powershell
node --import tsx --test --test-name-pattern="persistence failure marks managed lifecycle failed" src/runtime/agent-session/agent-session-manager.test.ts
node --import tsx --test src/runtime/agent-session/agent-session-manager.test.ts
```

Expected: both commands PASS.

- [ ] **Step 5: Commit lifecycle convergence**

```powershell
git add -- src/runtime/agent-session/agent-session-manager.ts src/runtime/agent-session/agent-session-manager.test.ts
git diff --cached --check
git commit -m "Fail managed lifecycle on persistence errors"
```

### Task 4: Keep Goal Detail Mounted During Stream-Triggered Refresh

**Files:**
- Create: `src/dashboard/goal-detail-refresh-state.ts`
- Create: `src/dashboard/goal-detail-refresh-state.test.ts`
- Modify: `src/dashboard/GoalDetail.tsx`

**Interfaces:**
- Consumes: `goalId`, `refreshKey`, and REST results for goal/events/session snapshot.
- Produces: `GoalDetailRefreshState`, `goalDetailRefreshReducer`, and UI behavior that blocks only without a usable selected-goal snapshot.

- [ ] **Step 1: Write failing reducer tests for initial, background, stale, and failed refreshes**

Create `goal-detail-refresh-state.test.ts` with four cases using a small snapshot fixture and these assertions:

```ts
let state = createGoalDetailRefreshState("goal-1");
state = goalDetailRefreshReducer(state, { type: "requested", goalId: "goal-1", requestId: 1 });
assert.equal(state.loading, true);

state = goalDetailRefreshReducer(state, { type: "succeeded", goalId: "goal-1", requestId: 1, snapshot: first });
state = goalDetailRefreshReducer(state, { type: "requested", goalId: "goal-1", requestId: 2 });
assert.equal(state.loading, false);
assert.equal(state.refreshing, true);
assert.equal(state.snapshot, first);

const stale = goalDetailRefreshReducer(state, {
  type: "succeeded", goalId: "goal-1", requestId: 1, snapshot: staleSnapshot,
});
assert.equal(stale.snapshot, first);

const failed = goalDetailRefreshReducer(state, {
  type: "failed", goalId: "goal-1", requestId: 2, error: "offline",
});
assert.equal(failed.snapshot, first);
assert.equal(failed.backgroundError, "offline");
assert.equal(failed.loading, false);
```

Also assert that a response for `goal-1` is ignored after state is reset for `goal-2`.

- [ ] **Step 2: Run the reducer test and observe the missing-module failure**

Run:

```powershell
node --import tsx --test src/dashboard/goal-detail-refresh-state.test.ts
```

Expected: FAIL because `goal-detail-refresh-state.ts` does not exist.

- [ ] **Step 3: Implement the refresh reducer**

Create these exported types and reducer branches:

```ts
export interface GoalDetailSnapshot {
  goal: Goal;
  latestMetadata: RunDisplayMetadata | null;
  agentSessionSnapshot: AgentSessionSnapshot | null;
}

export interface GoalDetailRefreshState {
  goalId: string;
  activeRequestId: number;
  snapshot: GoalDetailSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  blockingError: string | null;
  backgroundError: string | null;
}
```

`requested` for a different goal immediately replaces state with a fresh
loading state for that goal, so the previous goal can never render under the
new selection. `requested` for the current goal sets `loading` only when
`snapshot` is null, otherwise it sets `refreshing`. `succeeded` and `failed`
return the existing state unless both goal id and request id match. A matching
success replaces the snapshot and clears both errors. A matching failure uses
`blockingError` only without a snapshot and `backgroundError` otherwise.

- [ ] **Step 4: Run reducer tests and verify state ordering**

Run:

```powershell
node --import tsx --test src/dashboard/goal-detail-refresh-state.test.ts
```

Expected: all four behavior classes PASS.

- [ ] **Step 5: Wire `GoalDetail` to the reducer and request generations**

Replace the separate goal/metadata/snapshot/loading state with `useReducer`, and use a monotonic ref:

```ts
const [state, dispatch] = useReducer(goalDetailRefreshReducer, goalId, createGoalDetailRefreshState);
const nextRequestId = useRef(0);

useEffect(() => {
  const requestId = ++nextRequestId.current;
  let cancelled = false;
  dispatch({ type: "requested", goalId, requestId });
  Promise.all([getGoal(goalId), listEvents(goalId), getAgentSessionSnapshot(goalId)])
    .then(([goal, events, agentSessionSnapshot]) => {
      if (cancelled) return;
      dispatch({
        type: "succeeded",
        goalId,
        requestId,
        snapshot: { goal, latestMetadata: latestRunMetadata(events), agentSessionSnapshot },
      });
    })
    .catch((error) => {
      if (!cancelled) dispatch({ type: "failed", goalId, requestId, error: String(error) });
    });
  return () => { cancelled = true; };
}, [goalId, refreshKey, version]);
```

When `state.goalId !== goalId`, render the initial loading state so a prior goal never flashes under a new selection. When a same-goal snapshot exists, always render `GoalDetailPanel`; show `backgroundError` as a small non-blocking red paragraph above it. Keep action errors separate from refresh errors so approval/start/cancel failures remain visible without replacing the detail panel.

- [ ] **Step 6: Run all dashboard tests and typecheck**

Run:

```powershell
node --import tsx --test "src/dashboard/*.test.ts" "src/dashboard/*.test.tsx"
npm run typecheck
```

Expected: all dashboard tests PASS and TypeScript exits `0`.

- [ ] **Step 7: Commit non-flashing background refresh**

```powershell
git add -- src/dashboard/goal-detail-refresh-state.ts src/dashboard/goal-detail-refresh-state.test.ts src/dashboard/GoalDetail.tsx
git diff --cached --check
git commit -m "Keep goal detail visible during stream refresh"
```

### Task 5: Verify, Archive, and Synchronize the Main Specifications

**Files:**
- Update through archive: `openspec/specs/durable-managed-task-state/spec.md`
- Update through archive: `openspec/specs/agent-runtime-control-plane/spec.md`
- Update through archive: `openspec/specs/dashboard-goal-lifecycle/spec.md`
- Move through archive: `openspec/changes/fix-goal-scoped-task-identity-and-streaming-refresh/`

**Interfaces:**
- Consumes: all implementation commits and the validated OpenSpec change.
- Produces: a verified repository and archived requirements synchronized into main specs.

- [ ] **Step 1: Run the full completion gate from a clean application-code state**

Run:

```powershell
npm test
npm run typecheck
openspec validate fix-goal-scoped-task-identity-and-streaming-refresh --strict
openspec validate --all --strict
git diff --check
git status --short
```

Expected: both npm commands and both OpenSpec validations exit `0`; diff check is silent; status contains no unexpected files and may contain only the user's modified `data/auto-agent.sqlite` plus expected OpenSpec task-checkbox updates.

- [ ] **Step 2: Inspect migration blast radius on a disposable copy, never the live database**

Copy `data/auto-agent.sqlite` to a temporary directory, open the copy through a one-shot `openDatabase({ path })` script, and query:

```sql
SELECT goal_id, task_key, COUNT(*)
FROM managed_tasks
GROUP BY goal_id, task_key
HAVING COUNT(*) > 1;
PRAGMA foreign_key_check;
```

Expected: both queries return zero rows. Reopening the same copy must retain identical `internal_id` values. Do not open the live file with the new binary as part of this verification step.

- [ ] **Step 3: Archive the completed OpenSpec change**

Invoke the repository's `openspec-archive-change` workflow for `fix-goal-scoped-task-identity-and-streaming-refresh`, allowing it to synchronize the three delta specs into the main specs.

Run after archive:

```powershell
openspec validate --all --strict
git diff --check
```

Expected: validation exits `0` and the archive is located under `openspec/changes/archive/`.

- [ ] **Step 4: Commit the archive and synchronized specifications**

```powershell
git add -- openspec/specs openspec/changes/archive
git diff --cached --check
git commit -m "Archive goal-scoped task identity change"
```

Expected: the commit contains only archived OpenSpec artifacts and synchronized main specs; `data/auto-agent.sqlite` remains unstaged.

- [ ] **Step 5: Re-run final evidence checks after the last commit**

Run:

```powershell
npm test
npm run typecheck
openspec validate --all --strict
git diff --check
git status --short --branch
```

Expected: all verification commands exit `0`; branch status reports only the intentional live SQLite modification, if it is still present.
