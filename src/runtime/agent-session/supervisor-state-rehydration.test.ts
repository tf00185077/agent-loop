import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { createAgentSessionRepository, createEventRepository, createRunRepository } from "../../persistence/runtime-repositories.js";
import { GoalChangeRegistry } from "./change-registry.js";
import { GoalTaskRegistry } from "./task-registry.js";
import { rehydrateChangeRegistry, rehydrateTaskRegistry } from "./supervisor-state-rehydration.js";

const CAPS = { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };

function workerDelegation(db: AppDatabase, goalId: string, taskId: string): string {
  const run = createRunRepository(db).create({ goalId, provider: "mock", model: "m" });
  const sessions = createAgentSessionRepository(db);
  const parent = sessions.createSession({
    goalId, runId: run.id, providerId: "mock", modelLabel: "m", lifecycleState: "running", capabilities: CAPS,
  });
  return sessions.createDelegationRequest({ parentSessionId: parent.id, role: "worker", promptSummary: taskId, taskId }).id;
}

test("rehydrateTaskRegistry restores task structure, status, counts, and criteria from durable rows", () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "G", description: "d" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [
      { id: "task-1", title: "One", acceptance: [{ id: "A1", text: "alpha" }] },
      { id: "task-2", title: "Two", acceptance: [{ id: "B1", text: "beta" }] },
    ],
  });
  // task-1 has an in-flight attempt (delegated); task-2 stays registered.
  tasks.beginAttempt("task-1", workerDelegation(db, goal.id, "task-1"));

  const registry = new GoalTaskRegistry();
  rehydrateTaskRegistry(registry, tasks, goal.id);

  const one = registry.getTask("task-1");
  const two = registry.getTask("task-2");
  assert.equal(one?.status, "delegated");
  assert.equal(one?.attemptCount, 1);
  assert.deepEqual(one?.acceptance, [{ id: "A1", text: "alpha" }]);
  assert.equal(one?.criterionOutcomes.A1, "unknown");
  assert.equal(two?.status, "pending");
  assert.equal(two?.attemptCount, 0);
  assert.equal(registry.listTasks().length, 2);
  db.close();
});

test("rehydrateChangeRegistry replays the plan and transition events into the registry", () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "G", description: "d" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "m" });
  const events = createEventRepository(db);
  const emit = (data: Record<string, unknown>) =>
    events.create({ goalId: goal.id, runId: run.id, type: "agent.progress", message: "m", data });

  emit({
    runtimeEventType: "supervisor.change_plan",
    changePlan: [
      { id: "c1", title: "C1", rationale: "r1", dependsOn: [] },
      { id: "c2", title: "C2", rationale: "r2", dependsOn: ["c1"] },
    ],
  });
  emit({ runtimeEventType: "change.spec_approved", changeId: "c1" });
  emit({ runtimeEventType: "change.archived", changeId: "c1" });

  const registry = new GoalChangeRegistry();
  rehydrateChangeRegistry(registry, createManagedTaskRepository(db), goal.id, events.listForGoal(goal.id));

  assert.equal(registry.getChange("c1")?.status, "archived");
  assert.equal(registry.getChange("c2")?.status, "specifying");
  assert.equal(registry.activeChange()?.id, "c2");
  // A resumed supervisor re-announcing the plan is rejected (no re-scaffold).
  assert.equal(registry.registerPlan([{ id: "c1", title: "C1", rationale: "r", dependsOn: [] }]).ok, false);
  db.close();
});

test("rehydrateChangeRegistry replays multiple epochs and reassessments chronologically", () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "G", description: "d" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "m" });
  const events = createEventRepository(db);
  const emit = (data: Record<string, unknown>) =>
    events.create({ goalId: goal.id, runId: run.id, type: "agent.progress", message: "m", data });

  emit({
    runtimeEventType: "supervisor.change_plan",
    epochSequence: 1,
    changePlan: [{ id: "c1", title: "C1", rationale: "r1", dependsOn: [] }],
  });
  emit({ runtimeEventType: "change.spec_approved", changeId: "c1" });
  emit({ runtimeEventType: "change.archived", changeId: "c1" });
  emit({
    runtimeEventType: "supervisor.reassessment",
    epochSequence: 1,
    goalSatisfied: false,
    evidence: ["c1 archived"],
    remainingGaps: ["verification missing"],
    nextEpochRationale: "integration surfaced a gap",
  });
  emit({
    runtimeEventType: "supervisor.change_plan",
    epochSequence: 2,
    epochRationale: "integration surfaced a gap",
    changePlan: [{ id: "c2", title: "C2", rationale: "r2", dependsOn: [] }],
  });
  emit({ runtimeEventType: "change.spec_approved", changeId: "c2" });

  const registry = new GoalChangeRegistry();
  rehydrateChangeRegistry(registry, createManagedTaskRepository(db), goal.id, events.listForGoal(goal.id));

  assert.equal(registry.epochCount(), 2);
  assert.deepEqual(registry.listEpochs().map((epoch) => [epoch.sequence, epoch.rationale, epoch.changeIds]), [
    [1, null, ["c1"]],
    [2, "integration surfaced a gap", ["c2"]],
  ]);
  assert.equal(registry.getChange("c1")?.status, "archived");
  assert.equal(registry.getChange("c1")?.epochSequence, 1);
  assert.equal(registry.getChange("c2")?.status, "executing");
  assert.equal(registry.getChange("c2")?.epochSequence, 2);
  assert.equal(registry.activeChange()?.id, "c2");
  assert.equal(registry.latestReassessment()?.goalSatisfied, false);
  assert.equal(registry.latestReassessment()?.epochSequence, 1);
  assert.equal(registry.pendingNextEpoch(), false, "the replayed second plan consumed the gate");
  // No new plan without another unsatisfied reassessment.
  assert.equal(registry.registerNextEpoch([{ id: "c3", title: "C3", rationale: "r", dependsOn: [] }]).ok, false);
  db.close();
});

function specReviewFixture(name: string) {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: name, description: "d" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "m" });
  const events = createEventRepository(db);
  const emit = (data: Record<string, unknown>) =>
    events.create({ goalId: goal.id, runId: run.id, type: "agent.progress", message: "m", data });
  emit({
    runtimeEventType: "supervisor.change_plan",
    changePlan: [{ id: "c1", title: "C1", rationale: "r", dependsOn: [] }],
  });
  const rehydrate = () => {
    const registry = new GoalChangeRegistry();
    rehydrateChangeRegistry(registry, createManagedTaskRepository(db), goal.id, events.listForGoal(goal.id));
    return registry;
  };
  return { db, emit, rehydrate };
}

test("rehydration replays the full spec review chain to identical gate outcomes", () => {
  const { db, emit, rehydrate } = specReviewFixture("full spec chain");
  emit({ runtimeEventType: "change.spec_review_requested", changeId: "c1", workerDelegationRequestId: "worker-1" });
  emit({
    runtimeEventType: "change.spec_supervisor_approved", changeId: "c1",
    workerDelegationRequestId: "worker-1", summary: "Approved.",
  });
  const beforeMerge = rehydrate();
  assert.equal(beforeMerge.gateSpecReviewMerge("c1", "worker-1").ok, true);
  assert.equal(beforeMerge.gateSpecReviewMerge("c1", "worker-0").ok, false);

  emit({ runtimeEventType: "change.spec_merged", changeId: "c1", workerDelegationRequestId: "worker-1" });
  assert.equal(rehydrate().getChange("c1")?.status, "executing");
  db.close();
});

test("rehydration ignores spec merge events without an exact current approval", () => {
  for (const scenario of [
    { name: "absent approval", before: [] as Record<string, unknown>[], mergeId: "worker-1" },
    {
      name: "missing worker id",
      before: [
        { runtimeEventType: "change.spec_review_requested", changeId: "c1", workerDelegationRequestId: "worker-1" },
        { runtimeEventType: "change.spec_supervisor_approved", changeId: "c1", workerDelegationRequestId: "worker-1", summary: "Approved." },
      ],
      mergeId: undefined,
    },
    {
      name: "stale worker id after corrective attempt",
      before: [
        { runtimeEventType: "change.spec_review_requested", changeId: "c1", workerDelegationRequestId: "worker-1" },
        { runtimeEventType: "change.spec_supervisor_approved", changeId: "c1", workerDelegationRequestId: "worker-1", summary: "Approved." },
        { runtimeEventType: "managed_task.attempt_started", taskId: "spec:c1", workerDelegationRequestId: "worker-2" },
      ],
      mergeId: "worker-1",
    },
  ]) {
    const { db, emit, rehydrate } = specReviewFixture(scenario.name);
    for (const event of scenario.before) emit(event);
    emit({ runtimeEventType: "change.spec_merged", changeId: "c1", workerDelegationRequestId: scenario.mergeId });
    assert.equal(rehydrate().getChange("c1")?.status, "specifying", scenario.name);
    db.close();
  }
});

test("rehydration restores a rejected Supervisor decision and its conflict guidance", () => {
  const { db, emit, rehydrate } = specReviewFixture("rejected decision");
  emit({ runtimeEventType: "change.spec_review_requested", changeId: "c1", workerDelegationRequestId: "worker-1" });
  emit({
    runtimeEventType: "change.spec_supervisor_rejected", changeId: "c1",
    workerDelegationRequestId: "worker-1", summary: "Missing rollback scenario.",
  });
  const registry = rehydrate();
  assert.equal(registry.gateSpecReviewMerge("c1", "worker-1").ok, false);
  const conflict = registry.recordSpecReview({
    changeId: "c1", workerDelegationRequestId: "worker-1", decision: "approve", summary: "Fine now.",
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.ok ? "" : conflict.safeReason, /already rejected/i);
  assert.deepEqual(registry.getChange("c1")?.specReview.summary, "Missing rollback scenario.");
  db.close();
});
