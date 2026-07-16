import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { AgentRuntimeAdapter, AgentRuntimeEvent, AgentSessionHandle } from "../../domain/index.js";
import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedChangeArchiveRepository } from "../../persistence/managed-change-archive-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { evaluateManagedCompletion } from "./managed-completion-evaluator.js";
import {
  createOpenSpecWorkspaceService,
  type OpenSpecWorkspaceService,
} from "./openspec-workspace-service.js";
import { rehydrateTaskRegistry } from "./supervisor-state-rehydration.js";
import { GoalTaskRegistry } from "./task-registry.js";

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
      ambiguousTaskEnforcementIds: [],
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

test("restart rehydrates one committed split after a cache-refresh crash window", () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-split-restart-")), "runtime.sqlite");
  let db = openDatabase({ path });
  const goal = createGoalRepository(db).create({ title: "Split restart", description: "Commit before cache" });
  let tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{
      id: "parent", title: "Parent",
      acceptance: [{ id: "A1", text: "First" }, { id: "A2", text: "Second" }],
    }],
  });
  db.prepare(`
    UPDATE managed_tasks SET status = 'rejected', attempt_count = 2, substantive_rejection_count = 2,
      last_cited_criteria = '["A1"]'
    WHERE goal_id = ? AND logical_task_id = 'parent'
  `).run(goal.id);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{ id: "child", title: "First", parentTaskId: "parent", acceptance: [{ id: "A1", text: "First" }] }],
  });
  // Simulated process loss here: SQLite committed, but no in-memory cache was refreshed.
  db.close();

  db = openDatabase({ path });
  tasks = createManagedTaskRepository(db);
  const registry = new GoalTaskRegistry();
  rehydrateTaskRegistry(registry, tasks, goal.id);

  assert.equal(registry.getTask("parent")?.status, "split");
  assert.equal(registry.getTask("parent")?.attemptCount, 2);
  assert.equal(registry.getTask("parent")?.substantiveRejections, 2);
  assert.equal(registry.getTask("child")?.parentTaskId, "parent");
  assert.equal(tasks.getTask(goal.id, "child")?.changeId, "change-a");
  assert.deepEqual(tasks.listCriteria(goal.id, "child").map((criterion) => criterion.criterionId), ["A1"]);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{ id: "child", title: "First", parentTaskId: "parent", acceptance: [{ id: "A1", text: "First" }] }],
  });
  assert.equal(tasks.listForGoal(goal.id).length, 2);
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM events
    WHERE goal_id = ? AND json_extract(data, '$.runtimeEventType') = 'managed_task.lineage_split'
  `).pluck().get(goal.id), 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("post-registration cache refresh failure interrupts for restart instead of rejecting the committed task list", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-post-commit-rehydrate-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Post-commit refresh", description: "Interrupt after durable write" });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-17T00:00:00.000Z" });
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);
  let failRefresh = true;
  const faultingRepo = {
    ...tasks,
    listForGoal(goalId: string) {
      if (failRefresh) {
        failRefresh = false;
        throw new Error("injected post-commit cache read failure");
      }
      return tasks.listForGoal(goalId);
    },
  };
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      return restartHandle(input.sessionId, [{
        type: "progress",
        sessionId: input.sessionId,
        goalId: input.goalId,
        runId: input.runId,
        message: "Register task",
        occurredAt: "2026-07-17T00:00:01.000Z",
        metadata: { delegationControlEvent: {
          type: "managed_delegation.task_list",
          tasks: [{ id: "task-one", title: "Durable task", acceptance: [{ id: "A1", text: "Done" }] }],
        } },
      }]);
    },
  };
  const manager = createAgentSessionManager({
    database: db,
    managedTaskRepo: faultingRepo,
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo: sessions,
    maxSupervisorContinuations: 0,
  });

  await manager.startManagedSession({
    goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter,
  });

  assert.ok(tasks.getTask(goal.id, "task-one"), "durable registration committed before cache refresh failed");
  assert.equal(goalRepo.getById(goal.id)?.status, "interrupted");
  assert.equal(eventRepo.listForGoal(goal.id)
    .filter((event) => event.data.runtimeEventType === "managed_task.cache_refresh_failed").length, 1);
  assert.ok(!eventRepo.listForGoal(goal.id).some((event) =>
    event.data.runtimeEventType === "delegation.rejected" && /Task list rejected/.test(String(event.data.safeReason))
  ));
  assert.equal(sessions.listSessionsForGoal(goal.id)[0]?.lifecycleState, "stalled");
  db.close();
});

test("interrupted-goal rehydration fails before provider start and retries from durable lineage", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-rehydrate-fault-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Interrupted split", description: "Fail rehydrate once" });
  goalRepo.updateStatus(goal.id, "interrupted", { completedAt: "2026-07-17T00:00:00.000Z" });
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "task-1", title: "Resume", acceptance: [{ id: "A1", text: "Resume safely" }] }],
  });
  let providerStarts = 0;
  let capturedPrompt = "";
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      providerStarts += 1;
      capturedPrompt = input.prompt;
      return restartHandle(input.sessionId, []);
    },
  };
  const faultingRepo = {
    ...tasks,
    listForGoal() {
      throw new Error("injected rehydrate read failure");
    },
  };
  const faultingManager = createAgentSessionManager({
    database: db, managedTaskRepo: faultingRepo, goalRepo, runRepo, eventRepo, agentSessionRepo: sessions,
  });

  await assert.rejects(() => faultingManager.resumeInterruptedGoal({
    goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter,
  }), /injected rehydrate read failure/);
  assert.equal(providerStarts, 0);
  assert.equal(goalRepo.getById(goal.id)?.status, "interrupted");

  const recoveredManager = createAgentSessionManager({
    database: db, managedTaskRepo: tasks, goalRepo, runRepo, eventRepo, agentSessionRepo: sessions,
  });
  await recoveredManager.resumeInterruptedGoal({
    goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter,
  });
  assert.equal(providerStarts, 1);
  assert.match(capturedPrompt, /Resumed after backend restart/);
  assert.match(capturedPrompt, /task-1/);
  db.close();
});

test("restart reconciles a pending archive intent before starting the provider", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-archive-pending-restart-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Pending archive", description: "Resume after move or commit" });
  goalRepo.updateStatus(goal.id, "interrupted", { completedAt: "2026-07-17T00:00:00.000Z" });
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-one",
    tasks: [{ id: "spec:change-one", title: "Spec", acceptance: [{ id: "S1", text: "Valid" }] }],
  });
  eventRepo.create({
    goalId: goal.id,
    type: "agent.progress",
    message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [
        { id: "change-one", title: "One", rationale: "First" },
        { id: "change-two", title: "Two", rationale: "Second", dependsOn: ["change-one"] },
      ],
    },
  });
  const archives = createManagedChangeArchiveRepository(db);
  archives.beginIntent({
    goalId: goal.id,
    changeId: "change-one",
    sourcePath: "/goal/openspec/changes/change-one",
    targetPath: "/goal/openspec/changes/archive/2026-07-17-change-one",
    manifestDigest: "a".repeat(64),
    preArchiveHead: "head-before",
  });
  let archiveCalls = 0;
  let providerStarts = 0;
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive(input) {
      return {
        ok: true,
        sourcePath: `/goal/openspec/changes/${input.changeId}`,
        targetPath: `/goal/openspec/changes/archive/2026-07-17-${input.changeId}`,
        manifestDigest: "c".repeat(64),
        preArchiveHead: "head-after",
      };
    },
    archiveChange(input) {
      archiveCalls += 1;
      assert.equal(input.targetPath, "/goal/openspec/changes/archive/2026-07-17-change-one");
      return { ok: true, archiveCommitSha: "head-after", targetPath: input.targetPath };
    },
  };
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      providerStarts += 1;
      assert.equal(archives.get(goal.id, "change-one")?.status, "committed");
      assert.equal(eventRepo.listForGoal(goal.id)
        .filter((event) => event.data.runtimeEventType === "change.archived").length, 1);
      assert.equal(eventRepo.listForGoal(goal.id)
        .filter((event) => event.data.runtimeEventType === "change.activated"
          && event.data.changeId === "change-two").length, 1);
      return restartHandle(input.sessionId, []);
    },
  };
  const manager = createAgentSessionManager({
    database: db, managedTaskRepo: tasks, managedChangeArchiveRepo: archives,
    goalRepo, runRepo, eventRepo, agentSessionRepo: sessions,
    openSpecWorkspaceService: openSpec, supervisorCwd: "/goal", maxSupervisorContinuations: 0,
  });

  await manager.resumeInterruptedGoal({ goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter });

  assert.equal(archiveCalls, 1);
  assert.equal(providerStarts, 1);
  db.close();
});

test("restart blocks a database-backed active change when durable archive preparation is unavailable", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-archive-capability-restart-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Missing archive capability", description: "Must not resume" });
  goalRepo.updateStatus(goal.id, "interrupted", { completedAt: "2026-07-17T00:00:00.000Z" });
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-one",
    tasks: [{ id: "implementation", title: "Ready", acceptance: [{ id: "A1", text: "Pass" }] }],
  });
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
  db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
  eventRepo.create({
    goalId: goal.id,
    type: "agent.progress",
    message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [{ id: "change-one", title: "One", rationale: "Archive" }],
    },
  });
  eventRepo.create({
    goalId: goal.id,
    type: "agent.progress",
    message: "Spec approved",
    data: { runtimeEventType: "change.spec_approved", changeId: "change-one" },
  });
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    archiveChange() {
      throw new Error("legacy archive must not run during restart");
    },
  };
  let providerStarts = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      providerStarts += 1;
      return restartHandle(input.sessionId, []);
    },
  };
  const manager = createAgentSessionManager({
    database: db,
    managedTaskRepo: tasks,
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo: sessions,
    openSpecWorkspaceService: openSpec,
    supervisorCwd: "/goal",
    maxSupervisorContinuations: 0,
  });

  await manager.resumeInterruptedGoal({
    goalId: goal.id,
    providerId: "mock",
    modelLabel: "mock",
    adapter,
  });

  assert.equal(providerStarts, 0);
  assert.equal(goalRepo.getById(goal.id)?.status, "blocked");
  const blockers = eventRepo.listForGoal(goal.id).filter((event) =>
    event.data.runtimeEventType === "change.archive_blocked"
      && event.data.blockerType === "archive_capability_unavailable"
  );
  assert.equal(blockers.length, 1);
  assert.match(String(blockers[0]?.data.safeReason), /durable archive preparation is unavailable/i);
  assert.equal(createManagedChangeArchiveRepository(db).listForGoal(goal.id).length, 0);
  assert.equal(eventRepo.listForGoal(goal.id)
    .filter((event) => event.data.runtimeEventType === "recovery.resumed").length, 0);
  db.close();
});

test("real Git archive move and commit restart windows converge or durably block before provider resume", async () => {
  for (const faultWindow of ["after_move", "after_commit", "locked_after_move"] as const) {
    const root = mkdtempSync(join(tmpdir(), `managed-real-archive-${faultWindow}-`));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    restartGit(workspace, ["init", "-q"]);
    restartGit(workspace, ["config", "user.name", "Restart Test"]);
    restartGit(workspace, ["config", "user.email", "restart@example.invalid"]);
    const source = join(workspace, "openspec", "changes", "change-one");
    mkdirSync(join(source, "specs", "core"), { recursive: true });
    writeFileSync(join(source, "proposal.md"), "# Proposal\n", "utf8");
    writeFileSync(join(source, "tasks.md"), "# Tasks\n", "utf8");
    writeFileSync(join(source, "specs", "core", "spec.md"), "# Spec\n", "utf8");
    const nextSource = join(workspace, "openspec", "changes", "change-two");
    mkdirSync(join(nextSource, "specs", "core"), { recursive: true });
    writeFileSync(join(nextSource, "proposal.md"), "# Next proposal\n", "utf8");
    writeFileSync(join(nextSource, "tasks.md"), "# Next tasks\n", "utf8");
    writeFileSync(join(nextSource, "specs", "core", "spec.md"), "# Next spec\n", "utf8");
    restartGit(workspace, ["add", "."]);
    restartGit(workspace, ["commit", "-m", "initial"]);

    const databasePath = join(root, "runtime.sqlite");
    const db = openDatabase({ path: databasePath });
    const goalRepo = createGoalRepository(db);
    const goal = goalRepo.create({ title: faultWindow, description: "Real archive restart" });
    goalRepo.updateStatus(goal.id, "interrupted", { completedAt: "2026-07-17T00:00:00.000Z" });
    const runRepo = createRunRepository(db);
    const eventRepo = createEventRepository(db);
    const sessions = createAgentSessionRepository(db);
    const tasks = createManagedTaskRepository(db);
    tasks.registerTasks({
      goalId: goal.id,
      changeId: "change-one",
      tasks: [{ id: "spec:change-one", title: "Spec", acceptance: [{ id: "S1", text: "Valid" }] }],
    });
    db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
    db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
    eventRepo.create({
      goalId: goal.id,
      type: "agent.progress",
      message: "Plan",
      data: {
        runtimeEventType: "supervisor.change_plan",
        changePlan: [
          { id: "change-one", title: "One", rationale: "Archive" },
          { id: "change-two", title: "Two", rationale: "Next", dependsOn: ["change-one"] },
        ],
      },
    });
    const service = createOpenSpecWorkspaceService({ detectCli: () => null });
    const prepared = service.prepareArchive!({
      cwd: workspace, changeId: "change-one", date: "2026-07-17",
    });
    assert.equal(prepared.ok, true, faultWindow);
    if (!prepared.ok) continue;
    const archives = createManagedChangeArchiveRepository(db);
    archives.beginIntent({ goalId: goal.id, changeId: "change-one", ...prepared });
    if (faultWindow === "after_commit") {
      const archived = service.archiveChange({
        cwd: workspace, changeId: "change-one", date: "2026-07-17", ...prepared,
      });
      assert.equal(archived.ok, true);
    } else {
      mkdirSync(join(workspace, "openspec", "changes", "archive"), { recursive: true });
      renameSync(prepared.sourcePath, prepared.targetPath);
      if (faultWindow === "locked_after_move") {
        writeFileSync(join(workspace, ".git", "index.lock"), "locked\n", "utf8");
      }
    }
    let providerStarts = 0;
    const adapter: AgentRuntimeAdapter = {
      providerId: "mock",
      async detectCapabilities() {
        return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
      },
      async startSession(input) {
        providerStarts += 1;
        return restartHandle(input.sessionId, []);
      },
    };
    const manager = createAgentSessionManager({
      database: db,
      managedTaskRepo: tasks,
      managedChangeArchiveRepo: archives,
      goalRepo,
      runRepo,
      eventRepo,
      agentSessionRepo: sessions,
      openSpecWorkspaceService: service,
      supervisorCwd: workspace,
      maxSupervisorContinuations: 0,
    });

    await manager.resumeInterruptedGoal({
      goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter,
    });

    if (faultWindow === "locked_after_move") {
      assert.equal(providerStarts, 0);
      assert.equal(archives.get(goal.id, "change-one")?.status, "blocked");
      assert.ok(eventRepo.listForGoal(goal.id).some((event) =>
        event.data.runtimeEventType === "change.archive_blocked" && event.data.changeId === "change-one"
      ));
    } else {
      assert.equal(providerStarts, 1, JSON.stringify(eventRepo.listForGoal(goal.id).map((event) => ({
        runtimeEventType: event.data.runtimeEventType,
        safeReason: event.data.safeReason,
      }))));
      assert.equal(archives.get(goal.id, "change-one")?.status, "committed");
      assert.equal(eventRepo.listForGoal(goal.id)
        .filter((event) => event.data.runtimeEventType === "change.archived").length, 1);
      assert.equal(restartGit(workspace, ["status", "--porcelain", "-uall"]).stdout.trim(), "");
    }
    db.close();
  }
});

test("restart verifies a committed archive operation and repairs cache activation without duplicate events", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-archive-committed-restart-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Committed archive", description: "Crash before cache activation" });
  goalRepo.updateStatus(goal.id, "interrupted", { completedAt: "2026-07-17T00:00:00.000Z" });
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-one",
    tasks: [{ id: "spec:change-one", title: "Spec", acceptance: [{ id: "S1", text: "Valid" }] }],
  });
  eventRepo.create({
    goalId: goal.id,
    type: "agent.progress",
    message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [
        { id: "change-one", title: "One", rationale: "First" },
        { id: "change-two", title: "Two", rationale: "Second", dependsOn: ["change-one"] },
      ],
    },
  });
  const archives = createManagedChangeArchiveRepository(db);
  archives.beginIntent({
    goalId: goal.id,
    changeId: "change-one",
    sourcePath: "/goal/openspec/changes/change-one",
    targetPath: "/goal/openspec/changes/archive/2026-07-17-change-one",
    manifestDigest: "b".repeat(64),
    preArchiveHead: "head-before",
  });
  archives.finalize({
    goalId: goal.id, changeId: "change-one", archiveCommitSha: "head-after", runId: null,
    safeSummary: "Archived before restart.",
  });
  let archiveCalls = 0;
  let providerStarts = 0;
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive(input) {
      return {
        ok: true,
        sourcePath: `/goal/openspec/changes/${input.changeId}`,
        targetPath: `/goal/openspec/changes/archive/2026-07-17-${input.changeId}`,
        manifestDigest: "c".repeat(64),
        preArchiveHead: "head-after",
      };
    },
    archiveChange(input) {
      archiveCalls += 1;
      assert.equal(input.manifestDigest, "b".repeat(64));
      return { ok: true, archiveCommitSha: "head-after", targetPath: input.targetPath, idempotent: true };
    },
  };
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      providerStarts += 1;
      assert.equal(eventRepo.listForGoal(goal.id)
        .filter((event) => event.data.runtimeEventType === "change.archived").length, 1);
      assert.equal(eventRepo.listForGoal(goal.id)
        .filter((event) => event.data.runtimeEventType === "change.activated"
          && event.data.changeId === "change-two").length, 1);
      return restartHandle(input.sessionId, []);
    },
  };
  const manager = createAgentSessionManager({
    database: db, managedTaskRepo: tasks, managedChangeArchiveRepo: archives,
    goalRepo, runRepo, eventRepo, agentSessionRepo: sessions,
    openSpecWorkspaceService: openSpec, supervisorCwd: "/goal", maxSupervisorContinuations: 0,
  });

  await manager.resumeInterruptedGoal({ goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter });

  assert.equal(archiveCalls, 1);
  assert.equal(providerStarts, 1);
  db.close();
});

test("deterministic staged pipeline survives split-cache and archive-move restarts then completes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "managed-staged-fault-restart-")), "runtime.sqlite");
  let db = openDatabase({ path });
  let goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Staged fault regression", description: "Two rejections, split, two archives" });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-17T00:00:00.000Z" });
  let runRepo = createRunRepository(db);
  const seedRun = runRepo.create({ goalId: goal.id, provider: "mock", model: "mock" });
  let events = createEventRepository(db);
  events.create({
    goalId: goal.id, runId: seedRun.id, type: "agent.progress", message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [
        { id: "change-one", title: "One", rationale: "Split the broad task" },
        { id: "change-two", title: "Two", rationale: "Finish the tail", dependsOn: ["change-one"] },
      ],
    },
  });
  events.create({
    goalId: goal.id, runId: seedRun.id, type: "agent.progress", message: "Spec one approved",
    data: { runtimeEventType: "change.spec_approved", changeId: "change-one" },
  });
  let sessions = createAgentSessionRepository(db);
  const supervisor = sessions.createSession({
    goalId: goal.id, runId: seedRun.id, providerId: "mock", modelLabel: "mock", lifecycleState: "completed",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  let tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id, changeId: "change-one", runId: seedRun.id,
    tasks: [
      { id: "spec:change-one", title: "Spec one", acceptance: [{ id: "S1", text: "Valid" }] },
      { id: "parent", title: "Broad task", acceptance: [{ id: "A1", text: "First" }, { id: "A2", text: "Second" }] },
    ],
  });
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id = 'spec:change-one'")
    .run(goal.id);
  db.prepare(`UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'spec:change-one')`)
    .run(goal.id);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const request = sessions.createDelegationRequest({
      parentSessionId: supervisor.id, role: "worker", taskId: "parent", changeId: "change-one",
      promptSummary: `Parent attempt ${attempt}`,
    });
    tasks.beginAttempt("parent", request.id, seedRun.id, goal.id);
    sessions.acceptDelegationRequest(request.id);
    sessions.completeDelegationRequest(request.id, {
      kind: "success", safeSummary: `Parent candidate ${attempt}`,
      criterionEvidence: [{ criterionId: "A1", evidence: "Still failing" }], attestedFiles: ["src/parent.ts"],
    });
    tasks.recordExecutorEvidence({
      goalId: goal.id, taskId: "parent", workerDelegationRequestId: request.id,
      safeSummary: `Parent evidence ${attempt}`, criterionEvidence: [{ criterionId: "A1", evidence: "Still failing" }],
      runId: seedRun.id,
    });
    tasks.recordReview({
      goalId: goal.id, taskId: "parent", workerDelegationRequestId: request.id,
      judgeDelegationRequestId: null, reviewedCandidateCommitSha: `parent-${attempt}`, verdict: "rejected",
      decisions: [
        { criterionId: "A1", outcome: "FAIL", safeSummary: "A1 fails" },
        { criterionId: "A2", outcome: "PASS", safeSummary: "A2 passes" },
      ],
      safeSummary: "A1 fails", hasAttestedChanges: true, runId: seedRun.id,
    });
  }
  tasks.registerTasks({
    goalId: goal.id, changeId: "change-one", runId: seedRun.id,
    tasks: [{ id: "child", title: "First only", parentTaskId: "parent", acceptance: [{ id: "A1", text: "First" }] }],
  });
  const childRequest = sessions.createDelegationRequest({
    parentSessionId: supervisor.id, role: "worker", taskId: "child", changeId: "change-one",
    promptSummary: "Narrow child",
  });
  tasks.beginAttempt("child", childRequest.id, seedRun.id, goal.id);
  sessions.acceptDelegationRequest(childRequest.id);
  sessions.completeDelegationRequest(childRequest.id, {
    kind: "success", safeSummary: "Child candidate", criterionEvidence: [{ criterionId: "A1", evidence: "Pass" }],
    attestedFiles: ["src/child.ts"],
  });
  tasks.recordExecutorEvidence({
    goalId: goal.id, taskId: "child", workerDelegationRequestId: childRequest.id,
    safeSummary: "Child evidence", criterionEvidence: [{ criterionId: "A1", evidence: "Pass" }], runId: seedRun.id,
  });
  tasks.recordReview({
    goalId: goal.id, taskId: "child", workerDelegationRequestId: childRequest.id,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: "child-candidate", verdict: "accepted",
    decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Child accepted", hasAttestedChanges: true, runId: seedRun.id,
  });
  tasks.recordDelivery({
    goalId: goal.id, taskId: "child", workerDelegationRequestId: childRequest.id,
    status: "committed", safeSummary: "Child delivered", checkpointHead: "base",
    candidateCommitSha: "child-candidate", commitSha: "child-delivered", runId: seedRun.id,
  });
  tasks.registerTasks({
    goalId: goal.id, changeId: "change-two", runId: seedRun.id,
    tasks: [{ id: "spec:change-two", title: "Spec two", acceptance: [{ id: "S1", text: "Valid" }] }],
  });
  runRepo.updateStatus(seedRun.id, "completed", { finishedAt: "2026-07-17T00:05:00.000Z" });
  goalRepo.updateStatus(goal.id, "interrupted", { completedAt: "2026-07-17T00:05:00.000Z" });

  // Fault window 1: the split transaction and child delivery committed, but no process cache survived.
  db.close();
  db = openDatabase({ path });
  const archives = createManagedChangeArchiveRepository(db);
  archives.beginIntent({
    goalId: goal.id, changeId: "change-one",
    sourcePath: "/goal/openspec/changes/change-one",
    targetPath: "/goal/openspec/changes/archive/2026-07-17-change-one",
    manifestDigest: "a".repeat(64), preArchiveHead: "head-zero",
  });
  // Fault window 2: the exact target is already moved/committed, but SQLite finalization did not run.
  db.close();

  db = openDatabase({ path });
  goalRepo = createGoalRepository(db);
  runRepo = createRunRepository(db);
  events = createEventRepository(db);
  sessions = createAgentSessionRepository(db);
  tasks = createManagedTaskRepository(db);
  const archiveCalls: string[] = [];
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive(input) {
      return {
        ok: true,
        sourcePath: `/goal/openspec/changes/${input.changeId}`,
        targetPath: `/goal/openspec/changes/archive/2026-07-17-${input.changeId}`,
        manifestDigest: input.changeId === "change-one" ? "a".repeat(64) : "b".repeat(64),
        preArchiveHead: input.changeId === "change-one" ? "head-zero" : "head-one",
      };
    },
    archiveChange(input) {
      archiveCalls.push(input.changeId);
      return {
        ok: true, archiveCommitSha: input.changeId === "change-one" ? "head-one" : "head-two",
        targetPath: input.targetPath, manifestDigest: input.manifestDigest, idempotent: input.changeId === "change-one",
      };
    },
  };
  let supervisorTurn = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        const workerRequest = sessions.listSessionsForGoal(goal.id)
          .flatMap((session) => sessions.listDelegationRequests(session.id))
          .find((request) => request.role === "worker" && request.taskId === "spec:change-two")!;
        if (input.prompt.includes("Independent Judge contract")) {
          return restartHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Spec accepted", occurredAt: "2026-07-17T00:05:03.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerRequest.id,
                verdict: "accepted", decisions: [{ criterionId: "S1", outcome: "PASS", safeSummary: "Pass" }],
                safeSummary: "Spec accepted", deferredFindings: [],
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge complete", occurredAt: "2026-07-17T00:05:04.000Z" },
          ]);
        }
        return restartHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec result", occurredAt: "2026-07-17T00:05:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "spec:change-two",
              criterionEvidence: [{ criterionId: "S1", evidence: "Validated" }], claimedFiles: [], tests: [],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Worker complete", occurredAt: "2026-07-17T00:05:02.000Z" },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return restartHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Author tail spec", occurredAt: "2026-07-17T00:05:00.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker", taskId: "spec:change-two",
              prompt: "Author change-two specs", summary: "Author change-two specs",
            } },
          },
        ]);
      }
      const workerRequest = sessions.listSessionsForGoal(goal.id)
        .flatMap((session) => sessions.listDelegationRequests(session.id))
        .find((request) => request.role === "worker" && request.taskId === "spec:change-two");
      if (supervisorTurn === 2) {
        return restartHandle(input.sessionId, [{
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Review tail spec", occurredAt: "2026-07-17T00:05:02.500Z",
          metadata: { delegationControlEvent: {
            type: "managed_delegation.request", role: "review_merge",
            workerDelegationRequestId: workerRequest!.id, prompt: "Judge change-two spec", summary: "Judge change-two spec",
          } },
        }]);
      }
      if (supervisorTurn === 3) {
        return restartHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Close tail change", occurredAt: "2026-07-17T00:06:00.000Z",
            metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Tail ready" } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Need reassessment", occurredAt: "2026-07-17T00:06:01.000Z" },
        ]);
      }
      return restartHandle(input.sessionId, [
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Reassess", occurredAt: "2026-07-17T00:07:00.000Z",
          metadata: { delegationControlEvent: {
            type: "managed_goal.reassessment", goalSatisfied: true,
            evidence: ["Both ordered changes are durably archived after restart."],
          } },
        },
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Complete", occurredAt: "2026-07-17T00:07:01.000Z",
          metadata: { delegationControlEvent: {
            type: "managed_delegation.complete", summary: "Staged restart pipeline completed",
          } },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({
    database: db, managedTaskRepo: tasks, goalRepo, runRepo, eventRepo: events, agentSessionRepo: sessions,
    openSpecWorkspaceService: openSpec, supervisorCwd: "/goal", maxSupervisorContinuations: 10,
    worktreeService: {
      async createChildWorktree(input) {
        return { path: `/goal/worktrees/${input.childSessionId}`, label: `child-${input.childSessionId}` };
      },
      async removeWorktree() {},
    },
    reviewMergeWorkspaceService: {
      async prepareReviewMerge() {
        return { ok: true, checkpoint: { head: "head-one", statusSummary: "clean" } };
      },
    },
    reviewMergeVerificationService: {
      verifyMerged() {
        return {
          outcome: "merged", fixedTest: { command: "npm run typecheck", exitCode: 0, outputSummary: "passed" },
          revertEvidence: null, safeSummary: "Verified",
        };
      },
    },
  });

  await manager.resumeInterruptedGoal({ goalId: goal.id, providerId: "mock", modelLabel: "mock", adapter });
  for (let attempt = 0; attempt < 50 && goalRepo.getById(goal.id)?.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(
    goalRepo.getById(goal.id)?.status,
    "completed",
    JSON.stringify(events.listForGoal(goal.id).slice(-12).map((event) => ({
      type: event.type, runtime: event.data.runtimeEventType, reason: event.data.safeReason, message: event.message,
    }))),
  );
  assert.equal(tasks.getTask(goal.id, "parent")?.status, "split");
  assert.equal(tasks.getTask(goal.id, "child")?.status, "accepted");
  assert.equal(tasks.listDeliveries(goal.id, "child").filter((delivery) => delivery.status === "committed").length, 1);
  assert.deepEqual(archiveCalls, ["change-one", "change-two"]);
  assert.deepEqual(db.prepare(`SELECT change_id, status FROM managed_change_archive_operations
    WHERE goal_id = ? ORDER BY created_at, rowid`).all(goal.id), [
    { change_id: "change-one", status: "committed" },
    { change_id: "change-two", status: "committed" },
  ]);
  const timeline = events.listForGoal(goal.id);
  assert.deepEqual(timeline.filter((event) => event.data.runtimeEventType === "change.archived")
    .map((event) => event.data.changeId), ["change-one", "change-two"]);
  assert.equal(timeline.filter((event) => event.data.runtimeEventType === "change.activated"
    && event.data.changeId === "change-two").length, 1);
  assert.equal(timeline.filter((event) => event.data.runtimeEventType === "managed_task.lineage_split").length, 1);
  assert.equal(timeline.filter((event) => event.data.runtimeEventType === "supervisor.continuations_exhausted").length, 0);
  const rejectionReasons = timeline.filter((event) => event.data.runtimeEventType === "delegation.rejected")
    .map((event) => String(event.data.safeReason));
  assert.ok(rejectionReasons.every((reason) =>
    !/not active|Reassessment requires|existing worker result/i.test(reason)));
  assert.equal(timeline.find((event) => event.type === "goal.completed")?.message, "Staged restart pipeline completed");
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

function restartGit(cwd: string, args: string[]): { stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return { stdout: String(result.stdout) };
}
