import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { createAgentSessionRepository, createRunRepository } from "../../persistence/runtime-repositories.js";
import { evaluateManagedCompletion } from "./managed-completion-evaluator.js";

test("rejects completion for uncontracted-only work and unarchived plans", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "No tasks", description: "Ad hoc" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const supervisor = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  const uncontracted = sessions.createDelegationRequest({
    parentSessionId: supervisor.id, role: "worker", promptSummary: "Ad hoc",
  });
  sessions.acceptDelegationRequest(uncontracted.id);
  sessions.completeDelegationRequest(uncontracted.id, { kind: "success", safeSummary: "Ad hoc result" });
  const result = evaluateManagedCompletion(db, { goalId: goal.id, unarchivedChangeIds: ["change-a"] });
  assert.deepEqual(result.gaps.map((gap) => gap.type), ["uncontracted_only_work", "unarchived_change"]);
  db.close();
});

test("reports criterion, review, delivery, and leaf task gaps from durable state", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Gaps", description: "Durable" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Implement", acceptance: [{ id: "A1", text: "Pass" }] }],
  });

  const result = evaluateManagedCompletion(db, { goalId: goal.id });
  assert.deepEqual(result.gaps.map((gap) => gap.type), ["unaccepted_leaf_task", "criterion_not_passed"]);

  db.prepare("UPDATE managed_tasks SET status = 'awaiting_review' WHERE id = 'task-1'").run();
  const reviewGap = evaluateManagedCompletion(db, { goalId: goal.id });
  assert.ok(reviewGap.gaps.some((gap) => gap.type === "pending_review"));

  db.prepare("UPDATE managed_tasks SET status = 'awaiting_delivery'").run();
  const deliveryGap = evaluateManagedCompletion(db, { goalId: goal.id });
  assert.ok(deliveryGap.gaps.some((gap) => gap.type === "pending_delivery"));
  db.close();
});

test("accepts completed leaf descendants with PASS criteria", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Split", description: "Leaves" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({ goalId: goal.id, tasks: [{ id: "parent", title: "Large", acceptance: [{ id: "P1", text: "Split" }] }] });
  tasks.transition("parent", "split", { safeSummary: "Narrowed" });
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "child", title: "Leaf", parentTaskId: "parent", acceptance: [{ id: "C1", text: "Done" }] }],
  });
  db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS' WHERE task_id = 'child'").run();
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE id = 'child'").run();

  assert.deepEqual(evaluateManagedCompletion(db, { goalId: goal.id }), { ok: true, gaps: [] });
  db.close();
});

test("rejects completion while integration recovery is nonterminal or failed", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Integration", description: "Recovery" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Resolve", acceptance: [{ id: "A1", text: "Pass" }] }],
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const parent = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  db.prepare(`
    INSERT INTO agent_delegation_requests
      (id, parent_session_id, role, status, prompt_summary, task_id, created_at, updated_at)
    VALUES ('worker-1', ?, 'worker', 'completed', 'Worker', 'task-1', '2026-07-14', '2026-07-14')
  `).run(parent.id);
  tasks.beginAttempt("task-1", "worker-1");
  const integration = tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: "worker-1", checkpointHead: "base",
    originalCandidateCommitSha: "candidate", conflictFiles: ["src/a.ts"], allowedFiles: ["src/a.ts"],
    safeSummary: "Conflict",
  });
  assert.ok(evaluateManagedCompletion(db, { goalId: goal.id }).gaps.some((gap) => gap.type === "pending_integration"));
  tasks.transitionIntegration(integration.id, "resolution_failed", { safeSummary: "Failed" });
  assert.ok(evaluateManagedCompletion(db, { goalId: goal.id }).gaps.some((gap) => gap.type === "pending_integration"));
  db.close();
});

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "completion-evaluator-")), "test.sqlite");
}
