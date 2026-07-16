import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntimeAdapter, AgentRuntimeEvent, AgentSessionHandle } from "../../domain/index.js";
import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
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

test("manager completes a restarted broad staged ledger after rejected then accepted delivery without exhausting continuations", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-staged-restart-")), "runtime.sqlite");
  let db = openDatabase({ path });
  let goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Staged restart", description: "Repair and retry" });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-16T00:00:00.000Z" });
  let runRepo = createRunRepository(db);
  const seedRun = runRepo.create({ goalId: goal.id, provider: "mock", model: "mock" });
  let sessions = createAgentSessionRepository(db);
  const supervisor = sessions.createSession({
    goalId: goal.id, runId: seedRun.id, providerId: "mock", modelLabel: "mock", lifecycleState: "completed",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  let tasks = createManagedTaskRepository(db);
  const syntheticAcceptance = [
    { id: "S1", text: "Proposal is complete." },
    { id: "S2", text: "Delta specs are complete." },
    { id: "S3", text: "Tasks are complete." },
  ];
  const specChangeIds = ["change-one", "change-two", "change-three", "change-four"];
  const implementationIds = ["implementation", "implementation-two", "implementation-three", "implementation-four"];
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [
      ...specChangeIds.map((changeId) => ({
        id: `spec:${changeId}`, title: `Author ${changeId} specs`, acceptance: syntheticAcceptance,
      })),
      ...implementationIds.map((id, index) => ({
        id, title: `Implementation ${index + 1}`, acceptance: [{ id: `I${index + 1}`, text: "Implementation passes." }],
      })),
    ],
  });
  db.prepare(`
    UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id IN (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id LIKE 'spec:%')
  `).run(goal.id);
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id LIKE 'spec:%'")
    .run(goal.id);
  db.prepare(`
    UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id IN (
      SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id IN
        ('implementation-two', 'implementation-three', 'implementation-four')
    )
  `).run(goal.id);
  db.prepare(`
    UPDATE managed_tasks SET status = 'accepted'
    WHERE goal_id = ? AND logical_task_id IN ('implementation-two', 'implementation-three', 'implementation-four')
  `).run(goal.id);
  const mutationPrefixes = ["A", "B", "C", "D"];
  const restatedTasks = specChangeIds.map((changeId, index) => ({
    id: `spec:${changeId}`,
    title: `Restated ${changeId}`,
    acceptance: [
      { id: `${mutationPrefixes[index]}1`, text: `Guessed ${mutationPrefixes[index]} one.` },
      { id: `${mutationPrefixes[index]}2`, text: `Guessed ${mutationPrefixes[index]} two.` },
    ],
  }));
  db.prepare(`
    INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at) VALUES
      ('staged-plan', ?, ?, NULL, 'agent.progress', 'Plan', ?, '2026-07-16T00:00:01.000Z'),
      ('staged-restatement', ?, ?, NULL, 'agent.progress', 'Restatement', ?, '2026-07-16T00:00:02.000Z')
  `).run(
    goal.id,
    seedRun.id,
    JSON.stringify({
      runtimeEventType: "supervisor.change_plan",
      specTasks: specChangeIds.map((changeId) => ({
        taskId: `spec:${changeId}`, changeId, acceptance: syntheticAcceptance,
      })),
    }),
    goal.id,
    seedRun.id,
    JSON.stringify({
      runtimeEventType: "supervisor.task_list",
      taskList: restatedTasks,
      ignoredCriteriaMutations: restatedTasks.map((task) => task.id),
    }),
  );
  const insertPollutedCriterion = db.prepare(`
    INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at)
    VALUES (?, ?, ?, 'UNKNOWN', '2026-07-16T00:00:02.000Z', '2026-07-16T00:00:02.000Z')
  `);
  for (const task of restatedTasks) {
    const databaseId = db.prepare("SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = ?")
      .pluck().get(goal.id, task.id) as string;
    for (const criterion of task.acceptance) {
      insertPollutedCriterion.run(databaseId, criterion.id, criterion.text);
    }
  }

  const rejected = sessions.createDelegationRequest({
    parentSessionId: supervisor.id, role: "worker", taskId: "implementation", promptSummary: "First attempt",
  });
  tasks.beginAttempt("implementation", rejected.id, seedRun.id, goal.id);
  sessions.acceptDelegationRequest(rejected.id);
  sessions.completeDelegationRequest(rejected.id, {
    kind: "success", safeSummary: "First candidate", attestedFiles: ["src/change.ts"],
  });
  tasks.recordExecutorEvidence({
    goalId: goal.id, taskId: "implementation", workerDelegationRequestId: rejected.id,
    safeSummary: "First candidate",
  });
  tasks.recordReview({
    goalId: goal.id, taskId: "implementation", workerDelegationRequestId: rejected.id,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-rejected", verdict: "rejected",
    decisions: [{ criterionId: "I1", outcome: "FAIL", safeSummary: "Retry required" }],
    safeSummary: "Rejected", hasAttestedChanges: true,
  });
  db.prepare("DELETE FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'").run();
  db.close();

  db = openDatabase({ path });
  const reopenedSpecCriteria = db.prepare(`
    SELECT t.logical_task_id, c.criterion_id
    FROM managed_tasks t JOIN managed_task_criteria c ON c.task_id = t.id
    WHERE t.goal_id = ? AND t.logical_task_id LIKE 'spec:%'
    ORDER BY t.logical_task_id, c.criterion_id
  `).all(goal.id) as Array<{ logical_task_id: string; criterion_id: string }>;
  assert.equal(reopenedSpecCriteria.length, 12);
  assert.ok(reopenedSpecCriteria.every((row) => ["S1", "S2", "S3"].includes(row.criterion_id)));
  assert.deepEqual(
    JSON.parse(db.prepare(`
      SELECT details FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'
    `).pluck().get() as string),
    {
      mode: "initialized_repair", repairedTaskCount: 4, removedCriterionCount: 8,
      removedCriterionResultCount: 0, ambiguousTaskCount: 0, ambiguousTasks: [],
    },
  );
  goalRepo = createGoalRepository(db);
  runRepo = createRunRepository(db);
  sessions = createAgentSessionRepository(db);
  tasks = createManagedTaskRepository(db);
  const accepted = sessions.createDelegationRequest({
    parentSessionId: supervisor.id, role: "worker", taskId: "implementation", promptSummary: "Accepted retry",
  });
  tasks.beginAttempt("implementation", accepted.id, seedRun.id, goal.id);
  sessions.acceptDelegationRequest(accepted.id);
  sessions.completeDelegationRequest(accepted.id, {
    kind: "success", safeSummary: "Accepted candidate", attestedFiles: ["src/change.ts"],
  });
  tasks.recordExecutorEvidence({
    goalId: goal.id, taskId: "implementation", workerDelegationRequestId: accepted.id,
    safeSummary: "Accepted candidate",
  });
  tasks.recordReview({
    goalId: goal.id, taskId: "implementation", workerDelegationRequestId: accepted.id,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "candidate-accepted", verdict: "accepted",
    decisions: [{ criterionId: "I1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Accepted", hasAttestedChanges: true,
  });
  tasks.recordDelivery({
    goalId: goal.id, taskId: "implementation", workerDelegationRequestId: accepted.id,
    status: "committed", safeSummary: "Committed", checkpointHead: "base",
    candidateCommitSha: "candidate-accepted", commitSha: "delivered-accepted",
  });

  const eventRepo = createEventRepository(db);
  const manager = createAgentSessionManager({
    database: db, managedTaskRepo: tasks, goalRepo, runRepo, eventRepo, agentSessionRepo: sessions,
    maxSupervisorContinuations: 0,
  });
  await manager.startManagedSession({
    goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter: completionAdapter(),
  });

  assert.equal(goalRepo.getById(goal.id)?.status, "completed");
  const events = eventRepo.listForGoal(goal.id);
  assert.equal(events.filter((event) => event.type === "goal.completed").length, 1);
  assert.equal(events.filter((event) => event.data.runtimeEventType === "supervisor.continuations_exhausted").length, 0);
  assert.equal(tasks.listForGoal(goal.id).length, 8);
  assert.ok(tasks.listForGoal(goal.id).every((task) => task.status === "accepted"));
  assert.ok(tasks.listForGoal(goal.id).every((task) =>
    tasks.listCriteria(goal.id, task.id).every((criterion) => criterion.outcome === "PASS")));
  assert.deepEqual(evaluateManagedCompletion(db, { goalId: goal.id }), { ok: true, gaps: [] });
  db.close();
});

function completionAdapter(): AgentRuntimeAdapter {
  return {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      return restartHandle(input.sessionId, [
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Complete", occurredAt: "2026-07-16T00:00:10.000Z",
          metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Staged work delivered." } },
        },
        {
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Done", occurredAt: "2026-07-16T00:00:11.000Z",
        },
      ]);
    },
  };
}

function restartHandle(sessionId: string, events: AgentRuntimeEvent[]): AgentSessionHandle {
  return {
    sessionId,
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
    async *events() { for (const event of events) yield event; },
    async send() {}, async approve() {}, async reject() {}, async cancel() {},
  };
}
