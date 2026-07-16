import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { createAgentSessionRepository, createEventRepository, createRunRepository } from "../../persistence/runtime-repositories.js";
import { projectAgentLiveStatus } from "./agent-live-status.js";
import { projectManagedTaskContext } from "./managed-context-projection.js";

test("projects bounded durable task, criterion, judge, and delivery context equivalently after reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-context-")), "test.sqlite");
  let db = openDatabase({ path });
  const goal = createGoalRepository(db).create({ title: "Context", description: "Projection" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Task", acceptance: [{ id: "A1", text: "Pass" }] }],
  });
  createWorkerDelegation(db, goal.id, "task-1", "worker-1");
  tasks.beginAttempt("task-1", "worker-1");
  const integration = tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: "worker-1", checkpointHead: "base",
    originalCandidateCommitSha: "candidate-1", conflictFiles: ["src/a.ts"], allowedFiles: ["src/a.ts"],
    safeSummary: "Conflict",
  });
  tasks.transitionIntegration(integration.id, "resolving", {
    integratorDelegationRequestId: "worker-1", safeSummary: "Resolving",
  });
  tasks.transitionIntegration(integration.id, "awaiting_review", {
    safeSummary: "Resolved candidate ready", resolvedCandidateCommitSha: "candidate-2",
  });
  db.prepare(`
    UPDATE managed_tasks SET attempt_count = 2, substantive_rejection_count = 1,
      last_cited_criteria = '["A1"]', last_safe_summary = ?
    WHERE goal_id = ? AND logical_task_id = 'task-1'
  `).run("x".repeat(900), goal.id);
  const before = projectManagedTaskContext(tasks, goal.id);
  const liveBefore = projectFromDatabase(db, goal.id);
  assert.equal(before[0]?.lastSafeSummary.length, 500);
  assert.deepEqual(before[0]?.criteria, [{ id: "A1", text: "Pass", outcome: "UNKNOWN" }]);
  assert.equal(before[0]?.lastIntegrationStatus, "awaiting_review");
  assert.equal(before[0]?.integrationAttemptId, integration.id);
  assert.equal(liveBefore.phase, "rejudge");
  assert.equal(liveBefore.resolvedCandidateCommitSha, "candidate-2");
  db.close();

  db = openDatabase({ path });
  const after = projectManagedTaskContext(createManagedTaskRepository(db), goal.id);
  assert.deepEqual(after, before);
  assert.deepEqual(projectFromDatabase(db, goal.id), liveBefore);
  db.close();
});

test("projects interrupted integration equivalently after database reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "live-status-interrupted-")), "test.sqlite");
  let db = openDatabase({ path });
  const goal = createGoalRepository(db).create({ title: "Restart", description: "Interrupted recovery" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({ goalId: goal.id, tasks: [{ id: "task-1", title: "Recover", acceptance: [] }] });
  createWorkerDelegation(db, goal.id, "task-1", "worker-1");
  tasks.beginAttempt("task-1", "worker-1");
  tasks.beginIntegration({
    taskId: "task-1", workerDelegationRequestId: "worker-1", checkpointHead: "base",
    originalCandidateCommitSha: "candidate-1", conflictFiles: ["src/a.ts"], allowedFiles: ["src/a.ts"],
    safeSummary: "Conflict",
  });
  tasks.interruptNonterminalIntegrations(goal.id, "Integrator interrupted after restart");
  const before = projectFromDatabase(db, goal.id);
  assert.equal(before.state, "stalled");
  assert.equal(before.phase, "integrator");
  db.close();

  db = openDatabase({ path });
  assert.deepEqual(projectFromDatabase(db, goal.id), before);
  db.close();
});

function createWorkerDelegation(db: ReturnType<typeof openDatabase>, goalId: string, taskId: string, id: string): void {
  const run = createRunRepository(db).create({ goalId, provider: "mock", model: "mock" });
  const sessions = createAgentSessionRepository(db);
  const parent = sessions.createSession({
    goalId, runId: run.id, providerId: "mock", modelLabel: "mock", lifecycleState: "running",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  db.prepare(`
    INSERT INTO agent_delegation_requests
      (id, parent_session_id, role, status, prompt_summary, task_id, created_at, updated_at)
    VALUES (?, ?, 'worker', 'completed', 'Worker', ?, '2026-07-14', '2026-07-14')
  `).run(id, parent.id, taskId);
}

function projectFromDatabase(db: ReturnType<typeof openDatabase>, goalId: string) {
  const goal = createGoalRepository(db).getById(goalId)!;
  const sessionsRepository = createAgentSessionRepository(db);
  const sessions = sessionsRepository.listSessionsForGoal(goalId);
  return projectAgentLiveStatus({
    goal,
    sessions,
    approvals: sessions.flatMap((session) => sessionsRepository.listApprovalRequests(session.id)),
    delegations: sessions.flatMap((session) => sessionsRepository.listDelegationRequests(session.id)),
    managedTasks: projectManagedTaskContext(createManagedTaskRepository(db), goalId),
    events: createEventRepository(db).listForGoal(goalId),
  });
}
