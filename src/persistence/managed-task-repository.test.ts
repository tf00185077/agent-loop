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

test("persists one candidate-bound integration attempt through re-review and delivery", () => {
  const fixture = managedFixture();
  let { db } = fixture;
  const { path, goalId, delegationId } = fixture;
  let tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({
    goalId,
    tasks: [{ id: "task-1", title: "Integrate", acceptance: [{ id: "A1", text: "Merged behavior passes" }] }],
  });
  tasks.beginAttempt("task-1", delegationId);
  tasks.recordExecutorEvidence({ taskId: "task-1", workerDelegationRequestId: delegationId, safeSummary: "Worker done" });
  tasks.recordReview({
    taskId: "task-1", workerDelegationRequestId: delegationId, judgeDelegationRequestId: null,
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Original accepted" }],
    safeSummary: "Original candidate accepted", hasAttestedChanges: true,
  });
  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: delegationId, status: "conflict",
    safeSummary: "Conflict restored", checkpointHead: "base", candidateCommitSha: "candidate-1",
  });

  const integration = tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: delegationId, checkpointHead: "base",
    originalCandidateCommitSha: "candidate-1", conflictFiles: ["src/a.ts"], allowedFiles: ["src/a.ts"],
    safeSummary: "Conflict detected",
  });
  assert.equal(integration.status, "pending");
  assert.throws(() => tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: delegationId, checkpointHead: "base",
    originalCandidateCommitSha: "candidate-1", conflictFiles: [], allowedFiles: ["src/a.ts"], safeSummary: "Duplicate",
  }), /already exists/i);

  const integratorId = createDelegation(db, goalId, "task-1", "integrator");
  tasks.transitionIntegration(integration.id, "resolving", {
    safeSummary: "Integrator running", integratorDelegationRequestId: integratorId,
  });
  assert.throws(() => tasks.transitionIntegration(integration.id, "committed", { safeSummary: "Skip review" }), /Cannot transition/);
  tasks.transitionIntegration(integration.id, "awaiting_review", {
    safeSummary: "Resolved candidate created", resolvedCandidateCommitSha: "candidate-2",
  });

  db.close();
  db = openDatabase({ path });
  tasks = createManagedTaskRepository(db, { now: fixedNow });
  assert.equal(tasks.getIntegration(integration.id)?.status, "awaiting_review");
  assert.equal(tasks.getIntegration(integration.id)?.resolvedCandidateCommitSha, "candidate-2");

  const judgeId = createDelegation(db, goalId, "task-1", "review_merge");
  tasks.beginReview({
    taskId: "task-1", workerDelegationRequestId: delegationId, judgeDelegationRequestId: judgeId,
    integrationAttemptId: integration.id, reviewedCandidateCommitSha: "candidate-2", safeSummary: "Re-review pending",
  });
  const review = tasks.recordReview({
    taskId: "task-1", workerDelegationRequestId: delegationId, judgeDelegationRequestId: judgeId,
    integrationAttemptId: integration.id, reviewedCandidateCommitSha: "candidate-2",
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Resolved accepted" }],
    safeSummary: "Resolved candidate accepted", hasAttestedChanges: true,
  });
  assert.equal(review.integrationAttemptId, integration.id);
  assert.equal(review.reviewedCandidateCommitSha, "candidate-2");
  assert.equal(tasks.getIntegration(integration.id)?.status, "accepted");

  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: delegationId, integrationAttemptId: integration.id,
    status: "committed", safeSummary: "Integrated delivery committed", checkpointHead: "base",
    candidateCommitSha: "candidate-2", commitSha: "delivered-2",
  });
  assert.equal(tasks.getIntegration(integration.id)?.status, "committed");
  assert.equal(tasks.listDeliveries("task-1")[0]?.integrationAttemptId, integration.id);
  db.close();

  const reopenedDb = openDatabase({ path });
  const reopened = createManagedTaskRepository(reopenedDb);
  assert.deepEqual(reopened.listIntegrations("task-1")[0]?.conflictFiles, ["src/a.ts"]);
  assert.equal(reopened.listIntegrations("task-1")[0]?.resolvedCandidateCommitSha, "candidate-2");
  assert.equal(reopened.listReviews("task-1").at(-1)?.reviewedCandidateCommitSha, "candidate-2");
  reopenedDb.close();
});

test("marks a lost nonterminal Integrator attempt interrupted without permitting a duplicate", () => {
  const { db, goalId, delegationId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({ goalId, tasks: [{ id: "task-1", title: "Recover", acceptance: [] }] });
  tasks.beginAttempt("task-1", delegationId);
  const integration = tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: delegationId, checkpointHead: "base",
    originalCandidateCommitSha: "candidate-1", conflictFiles: ["a"], allowedFiles: ["a"], safeSummary: "Conflict",
  });
  tasks.interruptNonterminalIntegrations(goalId, "Integrator process unavailable after restart.");
  assert.equal(tasks.getIntegration(integration.id)?.status, "interrupted");
  assert.throws(() => tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: delegationId, checkpointHead: "base",
    originalCandidateCommitSha: "candidate-1", conflictFiles: ["a"], allowedFiles: ["a"], safeSummary: "Retry",
  }), /already exists/i);
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
  role: "worker" | "review_merge" | "integrator" = "worker",
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

test("recordDelivery upserts a pending intent then its terminal outcome into one row", () => {
  const { db, goalId, delegationId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({ goalId, tasks: [{ id: "task-1", title: "T", acceptance: [{ id: "A1", text: "Done" }] }] });
  tasks.beginAttempt("task-1", delegationId);

  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: delegationId, status: "pending",
    safeSummary: "prepared", candidateCommitSha: "cand-sha", checkpointHead: "chk", checkpointStatus: "clean",
  });
  assert.equal(tasks.listPendingDeliveries(goalId).length, 1);

  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: delegationId, status: "committed",
    safeSummary: "done", candidateCommitSha: "cand-sha", checkpointHead: "chk", commitSha: "final-sha",
  });
  const deliveries = tasks.listDeliveries("task-1");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.status, "committed");
  assert.equal(deliveries[0]?.candidateCommitSha, "cand-sha");
  assert.equal(deliveries[0]?.commitSha, "final-sha");
  assert.equal(tasks.listPendingDeliveries(goalId).length, 0);
  db.close();
});

test("listPendingDeliveries returns only pending rows for the goal", () => {
  const { db, goalId, delegationId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({ goalId, tasks: [
    { id: "task-1", title: "T1", acceptance: [{ id: "A1", text: "x" }] },
    { id: "task-2", title: "T2", acceptance: [{ id: "B1", text: "y" }] },
  ] });
  tasks.beginAttempt("task-1", delegationId);
  const del2 = createDelegation(db, goalId, "task-2");
  tasks.beginAttempt("task-2", del2);

  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: delegationId, status: "pending",
    safeSummary: "p", candidateCommitSha: "c1", checkpointHead: "h1",
  });
  tasks.recordDelivery({
    taskId: "task-2", workerDelegationRequestId: del2, status: "committed", safeSummary: "c", commitSha: "s2",
  });

  const pending = tasks.listPendingDeliveries(goalId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.taskId, "task-1");
  db.close();
});
