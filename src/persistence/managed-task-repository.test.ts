import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase, type AppDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";
import { createManagedTaskRepository } from "./managed-task-repository.js";
import { createAgentSessionRepository, createRunRepository } from "./runtime-repositories.js";

test("registers tasks and freezes immutable criteria across reopen", () => {
  const path = testDatabasePath();
  let db = openDatabase({ path });
  const goal = createGoalRepository(db).create({ title: "Durable", description: "Persist tasks" });
  const tasks = createManagedTaskRepository(db, { now: fixedNow });

  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Implement", acceptance: [{ id: "A1", text: "Tests pass" }] }],
  });
  const ignored = tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Changed", acceptance: [{ id: "A1", text: "Mutated" }] }],
  });
  assert.equal(ignored[0]?.title, "Implement");
  assert.equal(tasks.listCriteria("task-1")[0]?.text, "Tests pass");
  db.close();

  db = openDatabase({ path });
  const reopened = createManagedTaskRepository(db);
  assert.equal(reopened.getTask("task-1")?.status, "registered");
  assert.equal(reopened.listCriteria("task-1")[0]?.outcome, "UNKNOWN");
  assert.equal(reopened.listForGoal(goal.id).length, 1);
  db.close();
});

test("tracks attempts, executor claims, judge outcomes, rejection counts, delivery, and reopen", () => {
  const { db, path, goalId, delegationId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({
    goalId,
    tasks: [{
      id: "task-1",
      title: "Implement",
      acceptance: [{ id: "A1", text: "Tests pass" }, { id: "A2", text: "Docs updated" }],
    }],
  });

  assert.equal(tasks.beginAttempt("task-1", delegationId), 1);
  tasks.recordExecutorEvidence({
    taskId: "task-1",
    workerDelegationRequestId: delegationId,
    safeSummary: "Worker claims success",
    criterionEvidence: [{ criterionId: "A1", evidence: "npm test" }],
  });
  assert.equal(tasks.getTask("task-1")?.status, "awaiting_review");
  assert.deepEqual(tasks.listCriteria("task-1").map((item) => item.outcome), ["UNKNOWN", "UNKNOWN"]);

  tasks.recordReview({
    taskId: "task-1",
    workerDelegationRequestId: delegationId,
    judgeDelegationRequestId: null,
    verdict: "rejected",
    decisions: [
      { criterionId: "A1", outcome: "PASS", safeSummary: "Observed passing test" },
      { criterionId: "A2", outcome: "FAIL", safeSummary: "Missing docs" },
    ],
    safeSummary: "Docs missing",
    hasAttestedChanges: true,
  });
  assert.equal(tasks.getTask("task-1")?.status, "rejected");
  assert.equal(tasks.getTask("task-1")?.substantiveRejectionCount, 1);
  assert.deepEqual(tasks.getTask("task-1")?.lastCitedCriteria, ["A1", "A2"]);
  assert.deepEqual(tasks.listCriteria("task-1").map((item) => item.outcome), ["PASS", "FAIL"]);
  assert.equal(tasks.listCriterionResults(delegationId)[0]?.executorEvidence, "npm test");
  assert.throws(() => tasks.recordReview({
    taskId: "task-1", workerDelegationRequestId: delegationId, judgeDelegationRequestId: null,
    verdict: "rejected", decisions: [], safeSummary: "duplicate", hasAttestedChanges: true,
  }), /already reviewed/i);

  const nextDelegationId = createDelegation(db, goalId, "task-1");
  assert.equal(tasks.beginAttempt("task-1", nextDelegationId), 2);
  tasks.recordExecutorEvidence({ taskId: "task-1", workerDelegationRequestId: nextDelegationId, safeSummary: "Fixed" });
  tasks.recordReview({
    taskId: "task-1", workerDelegationRequestId: nextDelegationId, judgeDelegationRequestId: null,
    verdict: "accepted",
    decisions: [
      { criterionId: "A1", outcome: "PASS", safeSummary: "Pass" },
      { criterionId: "A2", outcome: "PASS", safeSummary: "Pass" },
    ],
    safeSummary: "Accepted", hasAttestedChanges: true,
  });
  assert.equal(tasks.getTask("task-1")?.status, "awaiting_delivery");
  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: nextDelegationId, status: "committed",
    safeSummary: "Delivered", commitSha: "abc123", validationCommand: "npm test", validationExitCode: 0,
  });
  assert.equal(tasks.getTask("task-1")?.status, "accepted");
  assert.equal(tasks.listDeliveries("task-1")[0]?.commitSha, "abc123");
  db.close();

  const reopenedDb = openDatabase({ path });
  const reopened = createManagedTaskRepository(reopenedDb);
  assert.equal(reopened.getTask("task-1")?.attemptCount, 2);
  assert.equal(reopened.getTask("task-1")?.substantiveRejectionCount, 1);
  assert.equal(reopened.listReviews("task-1").length, 2);
  assert.equal(reopened.listDeliveries("task-1")[0]?.status, "committed");
  assert.deepEqual(reopened.listCriteria("task-1").map((item) => item.outcome), ["PASS", "PASS"]);
  reopenedDb.close();
});

test("validates legal transitions and split lineage", () => {
  const { db, goalId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({ goalId, tasks: [{ id: "parent", title: "Large", acceptance: [{ id: "A1", text: "Done" }] }] });
  assert.throws(() => tasks.transition("parent", "accepted", { safeSummary: "claim" }), /Cannot transition/);
  tasks.transition("parent", "split", { safeSummary: "Narrowing" });
  tasks.registerTasks({
    goalId,
    tasks: [{ id: "child", title: "Narrow", parentTaskId: "parent", acceptance: [{ id: "C1", text: "Done" }] }],
  });
  assert.equal(tasks.getTask("child")?.parentTaskId, "parent");
  db.close();
});

test("persists malformed review and deferred findings without changing criterion authority", () => {
  const { db, goalId, delegationId } = managedFixture();
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId,
    tasks: [{ id: "task-1", title: "Review", acceptance: [{ id: "A1", text: "Pass" }] }],
  });
  tasks.beginAttempt("task-1", delegationId);
  tasks.recordExecutorEvidence({ taskId: "task-1", workerDelegationRequestId: delegationId, safeSummary: "Claim" });
  const judgeId = createDelegation(db, goalId, "task-1", "review_merge");
  tasks.beginReview({
    taskId: "task-1", workerDelegationRequestId: delegationId, judgeDelegationRequestId: judgeId,
    safeSummary: "Pending",
  });
  tasks.recordInvalidReview({
    taskId: "task-1", workerDelegationRequestId: delegationId, judgeDelegationRequestId: judgeId,
    safeSummary: "Missing A1 decision", deferredFindings: ["Style preference"],
  });
  assert.equal(tasks.listReviews("task-1")[0]?.status, "malformed");
  assert.deepEqual(tasks.listReviews("task-1")[0]?.deferredFindings, ["Style preference"]);
  assert.equal(tasks.getTask("task-1")?.status, "awaiting_review");
  assert.equal(tasks.getTask("task-1")?.substantiveRejectionCount, 0);
  assert.equal(tasks.listCriteria("task-1")[0]?.outcome, "UNKNOWN");
  db.close();
});

test("rolls back task state when its audit event cannot be inserted", () => {
  const { db, goalId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({ goalId, tasks: [{ id: "task-1", title: "Atomic", acceptance: [] }] });

  assert.throws(() => tasks.transition("task-1", "blocked", {
    safeSummary: "Blocked",
    runId: "missing-run",
  }), /FOREIGN KEY/);
  assert.equal(tasks.getTask("task-1")?.status, "registered");
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events WHERE goal_id = ?").get(goalId) as { count: number };
  assert.equal(eventCount.count, 1);
  db.close();
});

function managedFixture(): { db: AppDatabase; path: string; goalId: string; delegationId: string } {
  const path = testDatabasePath();
  const db = openDatabase({ path });
  const goal = createGoalRepository(db).create({ title: "Managed", description: "Fixture" });
  return { db, path, goalId: goal.id, delegationId: createDelegation(db, goal.id, "task-1") };
}

function createDelegation(
  db: AppDatabase,
  goalId: string,
  taskId: string,
  role: "worker" | "review_merge" = "worker",
): string {
  const run = createRunRepository(db).create({ goalId, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const session = sessions.createSession({
    goalId, runId: run.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  return sessions.createDelegationRequest({ parentSessionId: session.id, role, promptSummary: taskId, taskId }).id;
}

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "managed-task-repo-")), "test.sqlite");
}

const fixedNow = (): string => "2026-07-14T00:00:00.000Z";
