import assert from "node:assert/strict";
import Database from "better-sqlite3";
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

test("scopes duplicate logical task ids to their owning goals", () => {
  const path = testDatabasePath();
  const db = openDatabase({ path });
  const goals = createGoalRepository(db);
  const firstGoal = goals.create({ title: "First", description: "Own task" });
  const secondGoal = goals.create({ title: "Second", description: "Reuse task name" });
  const emptyGoal = goals.create({ title: "Empty", description: "Must not borrow another goal's task" });
  const tasks = createManagedTaskRepository(db, { now: fixedNow });

  tasks.registerTasks({
    goalId: firstGoal.id,
    tasks: [{ id: "spec:plan-foundation", title: "First plan", acceptance: [] }],
  });
  tasks.registerTasks({
    goalId: secondGoal.id,
    tasks: [{ id: "spec:plan-foundation", title: "Second plan", acceptance: [] }],
  });

  assert.equal(tasks.getTask(firstGoal.id, "spec:plan-foundation")?.title, "First plan");
  assert.equal(tasks.getTask(secondGoal.id, "spec:plan-foundation")?.title, "Second plan");
  assert.equal(tasks.getTask(secondGoal.id, "missing"), null);
  assert.equal(tasks.getTask(emptyGoal.id, "spec:plan-foundation"), null);
  assert.throws(() => tasks.transition("spec:plan-foundation", "blocked", {
    goalId: emptyGoal.id,
    safeSummary: "Must not cross goals",
  }), /not found in goal/i);
  assert.equal(tasks.getTask(firstGoal.id, "spec:plan-foundation")?.status, "registered");
  assert.equal(tasks.getTask(secondGoal.id, "spec:plan-foundation")?.status, "registered");
  const rows = db.prepare(`
    SELECT id, goal_id, logical_task_id FROM managed_tasks
    WHERE logical_task_id = ? ORDER BY goal_id
  `).all("spec:plan-foundation") as Array<{ id: string; goal_id: string; logical_task_id: string }>;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.id, rows[1]?.id);
  assert.ok(rows.every((row) => row.id !== row.logical_task_id));
  db.close();
});

test("migrates legacy logical primary keys to stable UUID identities without losing task history", () => {
  const path = testDatabasePath();
  createLegacyManagedTaskFixture(path);

  let db = openDatabase({ path });
  let tasks = createManagedTaskRepository(db);
  const migrated = db.prepare("SELECT id, logical_task_id FROM managed_tasks ORDER BY logical_task_id").all() as
    Array<{ id: string; logical_task_id: string }>;
  assert.deepEqual(migrated.map((row) => row.logical_task_id), ["child", "parent"]);
  assert.ok(migrated.every((row) => row.id !== row.logical_task_id));
  assert.equal(tasks.getTask("legacy-goal", "child")?.parentTaskId, "parent");
  assert.equal(tasks.listCriteria("legacy-goal", "child")[0]?.outcome, "PASS");
  assert.equal(tasks.listCriterionResults("worker-1")[0]?.taskId, "child");
  assert.equal(tasks.listReviews("legacy-goal", "child")[0]?.taskId, "child");
  assert.equal(tasks.listDeliveries("legacy-goal", "child")[0]?.taskId, "child");
  assert.equal(tasks.listIntegrations("legacy-goal", "child")[0]?.taskId, "child");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.throws(
    () => db.prepare("UPDATE managed_tasks SET logical_task_id = NULL WHERE logical_task_id = 'child'").run(),
    /managed_tasks\.logical_task_id is required/,
  );
  const firstIds = migrated.map((row) => row.id);
  db.close();

  db = openDatabase({ path });
  tasks = createManagedTaskRepository(db);
  const reopenedIds = (db.prepare("SELECT id FROM managed_tasks ORDER BY logical_task_id").all() as Array<{ id: string }>)
    .map((row) => row.id);
  assert.deepEqual(reopenedIds, firstIds);
  assert.equal(tasks.getTask("legacy-goal", "child")?.status, "accepted");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
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

function createLegacyManagedTaskFixture(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL, agent_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), status TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), run_id TEXT NOT NULL REFERENCES runs(id),
      provider_id TEXT NOT NULL, model_label TEXT, lifecycle_state TEXT NOT NULL, capabilities TEXT NOT NULL,
      parent TEXT, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL
    );
    CREATE TABLE agent_delegation_requests (
      id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      child_session_id TEXT REFERENCES agent_sessions(id), role TEXT NOT NULL, status TEXT NOT NULL,
      prompt_summary TEXT NOT NULL, task_id TEXT, change_id TEXT, acceptance TEXT, result_summary TEXT,
      detached_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT,
      started_at TEXT, completed_at TEXT, attempt_number INTEGER
    );
    CREATE TABLE managed_tasks (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), change_id TEXT,
      parent_task_id TEXT REFERENCES managed_tasks(id), title TEXT NOT NULL, status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, substantive_rejection_count INTEGER NOT NULL DEFAULT 0,
      last_cited_criteria TEXT NOT NULL DEFAULT '[]', last_safe_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (goal_id, id)
    );
    CREATE TABLE managed_task_criteria (
      task_id TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE, criterion_id TEXT NOT NULL,
      text TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'UNKNOWN', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (task_id, criterion_id)
    );
    CREATE TABLE managed_task_criterion_results (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_delegation_request_id TEXT NOT NULL
        REFERENCES agent_delegation_requests(id), criterion_id TEXT NOT NULL, executor_evidence TEXT,
      judge_outcome TEXT, judge_safe_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id, criterion_id) REFERENCES managed_task_criteria(task_id, criterion_id),
      UNIQUE (worker_delegation_request_id, criterion_id)
    );
    CREATE TABLE managed_task_integrations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      integrator_delegation_request_id TEXT REFERENCES agent_delegation_requests(id), status TEXT NOT NULL,
      checkpoint_head TEXT NOT NULL, original_candidate_commit_sha TEXT NOT NULL,
      resolved_candidate_commit_sha TEXT, conflict_files TEXT NOT NULL DEFAULT '[]',
      allowed_files TEXT NOT NULL DEFAULT '[]', safe_summary TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (worker_delegation_request_id, original_candidate_commit_sha)
    );
    CREATE TABLE managed_task_reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      judge_delegation_request_id TEXT REFERENCES agent_delegation_requests(id),
      integration_attempt_id TEXT REFERENCES managed_task_integrations(id), reviewed_candidate_commit_sha TEXT,
      status TEXT NOT NULL, verdict TEXT, decisions TEXT NOT NULL DEFAULT '[]',
      cited_criteria TEXT NOT NULL DEFAULT '[]', safe_summary TEXT NOT NULL,
      deferred_findings TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (judge_delegation_request_id)
    );
    CREATE TABLE managed_task_deliveries (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      integration_attempt_id TEXT REFERENCES managed_task_integrations(id), status TEXT NOT NULL CHECK (status IN (
        'pending', 'committed', 'rejected', 'conflict', 'integration_failed', 'test_failed_reverted',
        'revert_failed', 'failed', 'verification_failed'
      )), checkpoint_head TEXT, checkpoint_status TEXT, candidate_commit_sha TEXT, commit_sha TEXT,
      validation_command TEXT, validation_exit_code INTEGER, validation_summary TEXT, rollback_summary TEXT,
      safe_summary TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (worker_delegation_request_id)
    );
    INSERT INTO goals VALUES (
      'legacy-goal', 'Legacy', 'Migration fixture', 'completed', 'normal', 'general',
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', NULL, '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO runs VALUES (
      'legacy-run', 'legacy-goal', 'completed', 'mock', 'mock', '2026-07-14T00:00:00.000Z',
      '2026-07-14T00:00:00.000Z', NULL
    );
    INSERT INTO agent_sessions VALUES (
      'legacy-session', 'legacy-goal', 'legacy-run', 'mock', 'mock', 'completed', '{}', NULL,
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO agent_delegation_requests VALUES (
      'worker-1', 'legacy-session', NULL, 'worker', 'completed', 'child', 'child', NULL, NULL, NULL,
      NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', NULL, NULL,
      '2026-07-14T00:00:00.000Z', 1
    );
    INSERT INTO managed_tasks VALUES (
      'parent', 'legacy-goal', NULL, NULL, 'Parent', 'split', 0, 0, '[]', NULL,
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO managed_tasks VALUES (
      'child', 'legacy-goal', NULL, 'parent', 'Child', 'accepted', 1, 0, '["A1"]', 'Done',
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO managed_task_criteria VALUES (
      'child', 'A1', 'Done', 'PASS', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO managed_task_criterion_results VALUES (
      'criterion-result-1', 'child', 'worker-1', 'A1', 'Evidence', 'PASS', 'Accepted',
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO managed_task_integrations VALUES (
      'integration-1', 'child', 'worker-1', NULL, 'committed', 'base', 'candidate', 'resolved',
      '[]', '[]', 'Integrated', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO managed_task_reviews VALUES (
      'review-1', 'child', 'worker-1', NULL, 'integration-1', 'resolved', 'accepted', 'accepted',
      '[{"criterionId":"A1","outcome":"PASS","safeSummary":"Accepted"}]', '["A1"]',
      'Accepted', '[]', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO managed_task_deliveries VALUES (
      'delivery-1', 'child', 'worker-1', 'integration-1', 'committed', 'base', 'clean', 'resolved',
      'final', 'npm test', 0, 'pass', NULL, 'Delivered',
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
  `);
  db.close();
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

test("resetTaskForReDispatch resets to registered without charging the interrupted attempt", () => {
  const { db, goalId, delegationId } = managedFixture();
  const tasks = createManagedTaskRepository(db, { now: fixedNow });
  tasks.registerTasks({ goalId, tasks: [{ id: "task-1", title: "T", acceptance: [{ id: "A1", text: "x" }] }] });
  tasks.beginAttempt("task-1", delegationId);
  assert.equal(tasks.getTask("task-1")?.attemptCount, 1);
  assert.equal(tasks.getTask("task-1")?.status, "delegated");

  const reset = tasks.resetTaskForReDispatch("task-1");
  assert.equal(reset.status, "registered");
  assert.equal(reset.attemptCount, 0);
  assert.equal(reset.substantiveRejectionCount, 0);
  assert.equal(tasks.listCriteria("task-1").length, 1);
  db.close();
});
