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

  db.prepare("UPDATE managed_tasks SET status = 'awaiting_review' WHERE logical_task_id = 'task-1'").run();
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
  db.prepare(`
    UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'child')
  `).run(goal.id);
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id = 'child'")
    .run(goal.id);

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

test("creates delivery obligations only for accepted current changed candidates", () => {
  const accepted = completionFixture("Accepted pending");
  const acceptedWorker = completeWorkerAttempt(accepted, "accepted-worker", "candidate-accepted");
  accepted.tasks.recordReview({
    goalId: accepted.goal.id, taskId: "task-1", workerDelegationRequestId: acceptedWorker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-accepted",
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Accepted", hasAttestedChanges: true,
  });
  assert.deepEqual(
    evaluateManagedCompletion(accepted.db, { goalId: accepted.goal.id }).gaps
      .filter((gap) => gap.type === "undelivered_changes")
      .map((gap) => gap.delegationRequestId),
    [acceptedWorker],
  );
  accepted.tasks.recordDelivery({
    goalId: accepted.goal.id, taskId: "task-1", workerDelegationRequestId: acceptedWorker,
    status: "committed", safeSummary: "Committed", checkpointHead: "base",
    candidateCommitSha: "candidate-accepted", commitSha: "delivered-accepted",
  });
  assert.deepEqual(evaluateManagedCompletion(accepted.db, { goalId: accepted.goal.id }), { ok: true, gaps: [] });
  accepted.db.close();

  const rejected = completionFixture("Rejected candidate");
  const rejectedWorker = completeWorkerAttempt(rejected, "rejected-worker", "candidate-rejected");
  rejected.tasks.recordReview({
    goalId: rejected.goal.id, taskId: "task-1", workerDelegationRequestId: rejectedWorker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-rejected",
    verdict: "rejected", decisions: [{ criterionId: "A1", outcome: "FAIL", safeSummary: "Fails" }],
    safeSummary: "Rejected", hasAttestedChanges: true,
  });
  assert.ok(!evaluateManagedCompletion(rejected.db, { goalId: rejected.goal.id }).gaps
    .some((gap) => gap.type === "undelivered_changes"));
  rejected.db.close();
});

test("accepted committed retry supersedes rejected and terminal non-committed candidates", () => {
  const fixture = completionFixture("Retry");
  const rejectedWorker = completeWorkerAttempt(fixture, "worker-rejected", "candidate-rejected");
  fixture.tasks.recordReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: rejectedWorker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-rejected",
    verdict: "rejected", decisions: [{ criterionId: "A1", outcome: "FAIL", safeSummary: "Fails" }],
    safeSummary: "Rejected", hasAttestedChanges: true,
  });

  const failedWorker = completeWorkerAttempt(fixture, "worker-failed-delivery", "candidate-failed");
  fixture.tasks.recordReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: failedWorker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-failed",
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Accepted but delivery failed", hasAttestedChanges: true,
  });
  fixture.tasks.recordDelivery({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: failedWorker,
    status: "failed", safeSummary: "Terminal delivery failure", checkpointHead: "base",
    candidateCommitSha: "candidate-failed",
  });

  const acceptedWorker = completeWorkerAttempt(fixture, "worker-accepted", "candidate-current");
  fixture.tasks.recordReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: acceptedWorker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-current",
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Retry accepted", hasAttestedChanges: true,
  });
  fixture.tasks.recordDelivery({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: acceptedWorker,
    status: "committed", safeSummary: "Retry committed", checkpointHead: "base",
    candidateCommitSha: "candidate-current", commitSha: "delivered-current",
  });

  assert.deepEqual(evaluateManagedCompletion(fixture.db, { goalId: fixture.goal.id }), { ok: true, gaps: [] });
  assert.equal(fixture.tasks.listReviews(fixture.goal.id, "task-1").length, 3);
  assert.equal(fixture.tasks.listDeliveries(fixture.goal.id, "task-1").length, 2);
  fixture.db.close();
});

test("blocked, malformed, and abandoned historical candidates create no delivery obligation", () => {
  const fixture = completionFixture("Terminal candidates");
  const malformedWorker = completeWorkerAttempt(fixture, "worker-malformed", "candidate-malformed");
  const malformedJudge = fixture.sessions.createDelegationRequest({
    parentSessionId: fixture.supervisor.id, role: "review_merge", taskId: "task-1", promptSummary: "Malformed judge",
  });
  fixture.sessions.acceptDelegationRequest(malformedJudge.id);
  fixture.sessions.completeDelegationRequest(malformedJudge.id, { kind: "failure", safeSummary: "Malformed output" });
  fixture.tasks.recordInvalidReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: malformedWorker,
    judgeDelegationRequestId: malformedJudge.id, safeSummary: "Malformed review",
  });
  fixture.db.prepare("UPDATE managed_tasks SET status = 'failed' WHERE goal_id = ?").run(fixture.goal.id);

  const blockedWorker = completeWorkerAttempt(fixture, "worker-blocked", "candidate-blocked");
  fixture.tasks.recordReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: blockedWorker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-blocked", verdict: "blocked",
    decisions: [{ criterionId: "A1", outcome: "BLOCKED", safeSummary: "Blocked" }],
    safeSummary: "Blocked review", hasAttestedChanges: true,
  });

  const abandoned = fixture.sessions.createDelegationRequest({
    parentSessionId: fixture.supervisor.id, role: "worker", taskId: "task-1", promptSummary: "Abandoned",
  });
  fixture.tasks.beginAttempt("task-1", abandoned.id, null, fixture.goal.id);
  fixture.sessions.acceptDelegationRequest(abandoned.id);
  fixture.sessions.completeDelegationRequest(abandoned.id, {
    kind: "cancelled", safeSummary: "Abandoned candidate", attestedFiles: ["src/abandoned.ts"],
  });

  const result = evaluateManagedCompletion(fixture.db, { goalId: fixture.goal.id });
  assert.ok(!result.gaps.some((gap) => gap.type === "undelivered_changes"));
  assert.equal(fixture.tasks.listReviews(fixture.goal.id, "task-1").length, 2);
  fixture.db.close();
});

test("binds an integration delivery obligation to its accepted resolved candidate", () => {
  const fixture = completionFixture("Integrated candidate");
  const worker = completeWorkerAttempt(fixture, "integrated-worker", "candidate-original");
  fixture.tasks.recordReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: worker,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-original",
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Original accepted", hasAttestedChanges: true,
  });
  fixture.tasks.recordDelivery({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: worker,
    status: "conflict", safeSummary: "Conflict", checkpointHead: "base", candidateCommitSha: "candidate-original",
  });
  const integration = fixture.tasks.beginIntegration({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: worker,
    checkpointHead: "base", originalCandidateCommitSha: "candidate-original",
    conflictFiles: ["src/a.ts"], allowedFiles: ["src/a.ts"], safeSummary: "Integrate",
  });
  fixture.tasks.transitionIntegration(integration.id, "resolving", {
    integratorDelegationRequestId: createDelegation(fixture, "integrator"), safeSummary: "Resolving",
  });
  fixture.tasks.transitionIntegration(integration.id, "awaiting_review", {
    resolvedCandidateCommitSha: "candidate-resolved", safeSummary: "Resolved",
  });
  fixture.tasks.recordReview({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: worker,
    judgeDelegationRequestId: null, integrationAttemptId: integration.id,
    reviewedCandidateCommitSha: "candidate-resolved", verdict: "accepted",
    decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Resolved pass" }],
    safeSummary: "Resolved accepted", hasAttestedChanges: true,
  });
  assert.ok(evaluateManagedCompletion(fixture.db, { goalId: fixture.goal.id }).gaps
    .some((gap) => gap.type === "undelivered_changes" && gap.delegationRequestId === worker));
  fixture.tasks.recordDelivery({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: worker,
    integrationAttemptId: integration.id, status: "committed", safeSummary: "Resolved committed",
    checkpointHead: "base", candidateCommitSha: "candidate-resolved", commitSha: "delivered-resolved",
  });
  assert.deepEqual(evaluateManagedCompletion(fixture.db, { goalId: fixture.goal.id }), { ok: true, gaps: [] });
  fixture.db.close();
});

test("isolates every completion projection by Goal when logical task ids collide", () => {
  const path = testDatabasePath();
  const db = openDatabase({ path });
  const goals = createGoalRepository(db);
  const firstGoal = goals.create({ title: "First", description: "Must remain isolated" });
  const secondGoal = goals.create({ title: "Second", description: "Owns noisy history" });
  const tasks = createManagedTaskRepository(db);
  for (const goal of [firstGoal, secondGoal]) {
    tasks.registerTasks({
      goalId: goal.id,
      tasks: [{ id: "shared-task", title: "Shared logical id", acceptance: [{ id: "A1", text: "Done" }] }],
    });
  }
  db.prepare(`
    UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'shared-task')
  `).run(firstGoal.id);
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id = 'shared-task'")
    .run(firstGoal.id);

  const secondRun = createRunRepository(db).create({ goalId: secondGoal.id, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const secondSupervisor = sessions.createSession({
    goalId: secondGoal.id, runId: secondRun.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  const historical = sessions.createDelegationRequest({
    parentSessionId: secondSupervisor.id, role: "worker", taskId: "shared-task", promptSummary: "Historical elsewhere",
  });
  tasks.beginAttempt("shared-task", historical.id, null, secondGoal.id);
  sessions.acceptDelegationRequest(historical.id);
  sessions.completeDelegationRequest(historical.id, {
    kind: "success", safeSummary: "Changed elsewhere", attestedFiles: ["src/elsewhere.ts"],
  });
  tasks.recordExecutorEvidence({
    goalId: secondGoal.id, taskId: "shared-task", workerDelegationRequestId: historical.id,
    safeSummary: "Historical elsewhere",
  });
  tasks.recordReview({
    goalId: secondGoal.id, taskId: "shared-task", workerDelegationRequestId: historical.id,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-elsewhere", verdict: "accepted",
    decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass elsewhere" }],
    safeSummary: "Accepted elsewhere", hasAttestedChanges: true,
  });
  tasks.recordDelivery({
    goalId: secondGoal.id, taskId: "shared-task", workerDelegationRequestId: historical.id,
    status: "pending", safeSummary: "Pending elsewhere", candidateCommitSha: "candidate-elsewhere",
  });
  db.prepare("UPDATE managed_tasks SET status = 'failed' WHERE goal_id = ? AND logical_task_id = 'shared-task'").run(secondGoal.id);
  const active = sessions.createDelegationRequest({
    parentSessionId: secondSupervisor.id, role: "worker", taskId: "shared-task", promptSummary: "Active elsewhere",
  });
  tasks.beginAttempt("shared-task", active.id, null, secondGoal.id);
  sessions.acceptDelegationRequest(active.id);

  assert.deepEqual(evaluateManagedCompletion(db, { goalId: firstGoal.id }), { ok: true, gaps: [] });
  db.close();
});

type CompletionFixture = ReturnType<typeof completionFixture>;

function completionFixture(title: string) {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title, description: "Candidate obligation" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const supervisor = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Implement", acceptance: [{ id: "A1", text: "Done" }] }],
  });
  return { db, goal, run, sessions, supervisor, tasks };
}

function completeWorkerAttempt(fixture: CompletionFixture, summary: string, candidate: string): string {
  const worker = fixture.sessions.createDelegationRequest({
    parentSessionId: fixture.supervisor.id, role: "worker", taskId: "task-1", promptSummary: summary,
  });
  fixture.tasks.beginAttempt("task-1", worker.id, null, fixture.goal.id);
  fixture.sessions.acceptDelegationRequest(worker.id);
  fixture.sessions.completeDelegationRequest(worker.id, {
    kind: "success", safeSummary: summary,
    criterionEvidence: [{ criterionId: "A1", evidence: candidate }], attestedFiles: ["src/change.ts"],
  });
  fixture.tasks.recordExecutorEvidence({
    goalId: fixture.goal.id, taskId: "task-1", workerDelegationRequestId: worker.id,
    safeSummary: summary, criterionEvidence: [{ criterionId: "A1", evidence: candidate }],
  });
  return worker.id;
}

function createDelegation(fixture: CompletionFixture, role: "integrator" | "review_merge"): string {
  return fixture.sessions.createDelegationRequest({
    parentSessionId: fixture.supervisor.id, role, taskId: "task-1", promptSummary: role,
  }).id;
}

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "completion-evaluator-")), "test.sqlite");
}
