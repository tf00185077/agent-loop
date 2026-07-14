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

test("worker, review, delivery, and completion decisions survive separate database lifetimes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-restart-")), "runtime.sqlite");
  let db = openDatabase({ path });
  const goal = createGoalRepository(db).create({ title: "Restart", description: "Every phase" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const supervisor = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  let tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Durable", acceptance: [{ id: "A1", text: "Delivered" }] }],
  });
  const worker = sessions.createDelegationRequest({
    parentSessionId: supervisor.id, role: "worker", taskId: "task-1", promptSummary: "Work",
  });
  tasks.beginAttempt("task-1", worker.id);
  sessions.acceptDelegationRequest(worker.id);
  sessions.completeDelegationRequest(worker.id, {
    kind: "success", safeSummary: "Claim", criterionEvidence: [{ criterionId: "A1", evidence: "Evidence" }],
    attestedFiles: ["src/change.ts"],
  });
  tasks.recordExecutorEvidence({
    taskId: "task-1", workerDelegationRequestId: worker.id, safeSummary: "Claim",
    criterionEvidence: [{ criterionId: "A1", evidence: "Evidence" }],
  });
  db.close();

  db = openDatabase({ path });
  tasks = createManagedTaskRepository(db);
  const reopenedSessions = createAgentSessionRepository(db);
  const judge = reopenedSessions.createDelegationRequest({
    parentSessionId: supervisor.id, role: "review_merge", taskId: "task-1", promptSummary: "Judge",
  });
  tasks.beginReview({
    taskId: "task-1", workerDelegationRequestId: worker.id, judgeDelegationRequestId: judge.id,
    safeSummary: "Review pending",
  });
  tasks.recordReview({
    taskId: "task-1", workerDelegationRequestId: worker.id, judgeDelegationRequestId: judge.id,
    verdict: "accepted", decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Accepted", hasAttestedChanges: true,
  });
  db.close();

  db = openDatabase({ path });
  tasks = createManagedTaskRepository(db);
  tasks.recordDelivery({
    taskId: "task-1", workerDelegationRequestId: worker.id, status: "committed", safeSummary: "Delivered",
    checkpointHead: "base", candidateCommitSha: "candidate", commitSha: "delivered", validationCommand: "npm test",
    validationExitCode: 0, validationSummary: "passed",
  });
  db.close();

  db = openDatabase({ path });
  assert.deepEqual(evaluateManagedCompletion(db, { goalId: goal.id }), { ok: true, gaps: [] });
  assert.equal(createManagedTaskRepository(db).getTask("task-1")?.status, "accepted");
  db.close();
});
