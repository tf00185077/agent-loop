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
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{
      id: "parent", title: "Large",
      acceptance: [{ id: "P1", text: "First" }, { id: "P2", text: "Second" }],
    }],
  });
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

test("fails closed when an accepted passing task has an ambiguous frozen contract migration", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Ambiguous contract", description: "Must not complete" });
  createManagedTaskRepository(db).registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{ id: "implementation", title: "Guessed contract", acceptance: [{ id: "A1", text: "Guessed pass" }] }],
  });
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
  db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
  db.prepare(`
    UPDATE schema_migrations SET details = ?
    WHERE name = 'managed-task-frozen-contract-repair-v1'
  `).run(JSON.stringify({
    mode: "initialized_repair",
    ambiguousTaskCount: 1,
    ambiguousTasks: [`${goal.id}:implementation`],
  }));

  const result = evaluateManagedCompletion(db, { goalId: goal.id });

  assert.equal(result.ok, false);
  assert.deepEqual(result.gaps.filter((gap) => gap.reasonCode === "ambiguous_frozen_contract"), [{
    type: "invalid_split_lineage",
    reasonCode: "ambiguous_frozen_contract",
    taskId: "implementation",
    taskIds: ["implementation"],
    safeSummary: "Managed task implementation has an ambiguous frozen acceptance contract (ambiguous_frozen_contract).",
  }]);
  db.close();
});

test("fails closed on the 51st frozen-contract ambiguity while legal Goals remain unaffected", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goals = createGoalRepository(db);
  const ambiguousGoal = goals.create({ title: "51st ambiguity", description: "Must not complete" });
  const legalGoal = goals.create({ title: "Legal Goal", description: "Must remain unaffected" });
  const tasks = createManagedTaskRepository(db);
  for (const goal of [ambiguousGoal, legalGoal]) {
    tasks.registerTasks({
      goalId: goal.id,
      changeId: "change-a",
      tasks: [{ id: "implementation", title: "Passing task", acceptance: [{ id: "A1", text: "Pass" }] }],
    });
    db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
    db.prepare(`UPDATE managed_task_criteria SET outcome = 'PASS'
      WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'implementation')`)
      .run(goal.id);
  }
  const boundedDiagnostics = Array.from({ length: 50 }, (_, index) =>
    `other-goal-${String(index + 1).padStart(3, "0")}:implementation`
  );
  db.prepare(`UPDATE schema_migrations SET details = ?
    WHERE name = 'managed-task-frozen-contract-repair-v1'`).run(JSON.stringify({
    mode: "initialized_repair",
    ambiguousTaskCount: 51,
    ambiguousTasks: boundedDiagnostics,
    ambiguousTaskEnforcementIds: [...boundedDiagnostics, `${ambiguousGoal.id}:implementation`],
  }));

  const ambiguous = evaluateManagedCompletion(db, { goalId: ambiguousGoal.id });

  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.gaps.some((gap) =>
    gap.reasonCode === "ambiguous_frozen_contract" && gap.taskId === "implementation"
  ));
  assert.deepEqual(evaluateManagedCompletion(db, { goalId: legalGoal.id }), { ok: true, gaps: [] });
  db.close();
});

test("fails closed globally for legacy truncated frozen-contract markers", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Legacy marker", description: "Unknown omitted owners" });
  createManagedTaskRepository(db).registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{ id: "implementation", title: "Passing task", acceptance: [{ id: "A1", text: "Pass" }] }],
  });
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
  db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
  db.prepare(`UPDATE schema_migrations SET details = ?
    WHERE name = 'managed-task-frozen-contract-repair-v1'`).run(JSON.stringify({
    mode: "initialized_repair",
    ambiguousTaskCount: 51,
    ambiguousTasks: Array.from({ length: 50 }, (_, index) => `unknown-goal-${index}:unknown-task`),
  }));

  const result = evaluateManagedCompletion(db, { goalId: goal.id });

  assert.equal(result.ok, false);
  assert.ok(result.gaps.some((gap) =>
    gap.reasonCode === "ambiguous_frozen_contract" && (gap.taskIds?.length ?? 0) === 0
  ));
  db.close();
});

test("fails closed for present frozen-contract markers with invalid details", async (t) => {
  for (const marker of [
    { name: "malformed JSON", details: "{not-json" },
    { name: "valid JSON non-object", details: "[]" },
  ]) {
    await t.test(marker.name, () => {
      const db = openDatabase({ path: testDatabasePath() });
      const goal = createGoalRepository(db).create({ title: marker.name, description: "Invalid marker" });
      createManagedTaskRepository(db).registerTasks({
        goalId: goal.id,
        changeId: "change-a",
        tasks: [{ id: "implementation", title: "Passing task", acceptance: [{ id: "A1", text: "Pass" }] }],
      });
      db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
      db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
      db.prepare(`UPDATE schema_migrations SET details = ?
        WHERE name = 'managed-task-frozen-contract-repair-v1'`).run(marker.details);

      const result = evaluateManagedCompletion(db, { goalId: goal.id });

      assert.equal(result.ok, false);
      assert.ok(result.gaps.some((gap) =>
        gap.reasonCode === "ambiguous_frozen_contract" && (gap.taskIds?.length ?? 0) === 0
      ));
      db.close();
    });
  }
});

test("keeps absent and valid frozen-contract marker forms non-global", async (t) => {
  const cases: Array<{ name: string; details?: Record<string, unknown> }> = [
    { name: "marker absent" },
    { name: "fresh baseline", details: { mode: "fresh_baseline" } },
    {
      name: "zero ambiguity",
      details: {
        mode: "initialized_repair",
        ambiguousTaskCount: 0,
        ambiguousTasks: [],
        ambiguousTaskEnforcementIds: [],
      },
    },
    {
      name: "task-scoped old marker",
      details: {
        mode: "initialized_repair",
        ambiguousTaskCount: 1,
        ambiguousTasks: ["another-goal:implementation"],
      },
    },
    {
      name: "full enforcement identities",
      details: {
        mode: "initialized_repair",
        ambiguousTaskCount: 1,
        ambiguousTasks: ["another-goal:implementation"],
        ambiguousTaskEnforcementIds: ["another-goal:implementation"],
      },
    },
  ];
  for (const marker of cases) {
    await t.test(marker.name, () => {
      const db = openDatabase({ path: testDatabasePath() });
      const goal = createGoalRepository(db).create({ title: marker.name, description: "Valid marker" });
      createManagedTaskRepository(db).registerTasks({
        goalId: goal.id,
        changeId: "change-a",
        tasks: [{ id: "implementation", title: "Passing task", acceptance: [{ id: "A1", text: "Pass" }] }],
      });
      db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(goal.id);
      db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
      if (marker.details) {
        db.prepare(`UPDATE schema_migrations SET details = ?
          WHERE name = 'managed-task-frozen-contract-repair-v1'`).run(JSON.stringify(marker.details));
      } else {
        db.prepare(`DELETE FROM schema_migrations
          WHERE name = 'managed-task-frozen-contract-repair-v1'`).run();
      }

      assert.deepEqual(evaluateManagedCompletion(db, { goalId: goal.id }), { ok: true, gaps: [] });
      db.close();
    });
  }
});

test("fails closed for a non-split parent with a child", () => {
  const fixture = lineageFixture();
  fixture.db.prepare("UPDATE managed_tasks SET status = 'rejected' WHERE goal_id = ? AND logical_task_id = 'parent'")
    .run(fixture.goalId);

  const result = evaluateManagedCompletion(fixture.db, { goalId: fixture.goalId });

  assert.deepEqual(
    result.gaps.filter((gap) => gap.type === "invalid_split_lineage")
      .map((gap) => [gap.taskId, gap.safeSummary]),
    [["parent", "Managed task parent has descendants but is not split (parent_not_split)."]],
  );
  fixture.db.close();
});

test("fails closed for a split parent without a child", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Empty split", description: "Invalid lineage" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    tasks: [{ id: "parent", title: "Large", acceptance: [{ id: "P1", text: "One" }, { id: "P2", text: "Two" }] }],
  });
  db.prepare("UPDATE managed_tasks SET status = 'split' WHERE goal_id = ? AND logical_task_id = 'parent'").run(goal.id);

  const result = evaluateManagedCompletion(db, { goalId: goal.id });

  assert.ok(result.gaps.some((gap) =>
    gap.type === "invalid_split_lineage" && gap.taskId === "parent" && /split_without_children/.test(gap.safeSummary)
  ));
  db.close();
});

test("fails closed for cross-change, missing-parent, and cyclic lineage", () => {
  const scenarios = [
    {
      name: "cross_change",
      corrupt(db: ReturnType<typeof openDatabase>, goalId: string) {
        db.prepare("UPDATE managed_tasks SET change_id = 'change-b' WHERE goal_id = ? AND logical_task_id = 'child'")
          .run(goalId);
      },
    },
    {
      name: "missing_parent",
      corrupt(db: ReturnType<typeof openDatabase>, goalId: string) {
        db.pragma("foreign_keys = OFF");
        db.prepare("UPDATE managed_tasks SET parent_task_id = 'missing-row' WHERE goal_id = ? AND logical_task_id = 'child'")
          .run(goalId);
        db.pragma("foreign_keys = ON");
      },
    },
    {
      name: "cycle",
      corrupt(db: ReturnType<typeof openDatabase>, goalId: string) {
        const ids = db.prepare("SELECT logical_task_id, id FROM managed_tasks WHERE goal_id = ?")
          .all(goalId) as Array<{ logical_task_id: string; id: string }>;
        const byLogicalId = new Map(ids.map((row) => [row.logical_task_id, row.id]));
        db.prepare("UPDATE managed_tasks SET parent_task_id = ? WHERE goal_id = ? AND logical_task_id = 'parent'")
          .run(byLogicalId.get("child"), goalId);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = lineageFixture();
    scenario.corrupt(fixture.db, fixture.goalId);

    const result = evaluateManagedCompletion(fixture.db, { goalId: fixture.goalId });

    assert.ok(result.gaps.some((gap) =>
      gap.type === "invalid_split_lineage" && gap.safeSummary.includes(`(${scenario.name})`)
    ), `expected ${scenario.name} lineage diagnostic`);
    fixture.db.close();
  }
});

test("fails closed when a durable child points at a parent in another Goal", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goals = createGoalRepository(db);
  const parentGoal = goals.create({ title: "Parent Goal", description: "Owns the parent" });
  const childGoal = goals.create({ title: "Child Goal", description: "Must not borrow the parent" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: parentGoal.id,
    tasks: [{
      id: "parent", title: "Parent",
      acceptance: [{ id: "P1", text: "One" }, { id: "P2", text: "Two" }],
    }],
  });
  const parentDatabaseId = db.prepare(`
    SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'parent'
  `).pluck().get(parentGoal.id) as string;
  db.prepare(`
    INSERT INTO managed_tasks (
      id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
      substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
    ) VALUES ('cross-goal-child-db', ?, 'child', NULL, ?, 'Child', 'accepted', 0, 0, '[]', NULL,
      '2026-07-17T00:00:01.000Z', '2026-07-17T00:00:01.000Z')
  `).run(childGoal.id, parentDatabaseId);
  db.prepare(`
    INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at)
    VALUES ('cross-goal-child-db', 'C1', 'Done', 'PASS',
      '2026-07-17T00:00:01.000Z', '2026-07-17T00:00:01.000Z')
  `).run();

  const result = evaluateManagedCompletion(db, { goalId: childGoal.id });

  assert.ok(result.gaps.some((gap) =>
    gap.type === "invalid_split_lineage" && gap.reasonCode === "cross_goal"
      && gap.taskIds?.includes("child") && gap.taskIds.includes("parent")
  ));
  db.close();
});

test("fails closed when durable descendants no longer match frozen split evidence", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Frozen split", description: "Tamper detection" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{
      id: "parent", title: "Parent",
      acceptance: [{ id: "P1", text: "One" }, { id: "P2", text: "Two" }, { id: "P3", text: "Three" }],
    }],
  });
  db.prepare(`
    UPDATE managed_tasks SET status = 'rejected', substantive_rejection_count = 2
    WHERE goal_id = ? AND logical_task_id = 'parent'
  `).run(goal.id);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{
      id: "child", title: "Original child", parentTaskId: "parent",
      acceptance: [{ id: "C1", text: "One" }, { id: "C2", text: "Two" }],
    }],
  });
  const parentDatabaseId = db.prepare(`
    SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'parent'
  `).pluck().get(goal.id) as string;
  db.prepare(`
    INSERT INTO managed_tasks (
      id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
      substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
    ) VALUES ('tampered-child-db', ?, 'tampered-child', 'change-a', ?, 'Tampered child', 'accepted',
      0, 0, '[]', NULL, '2026-07-17T00:00:02.000Z', '2026-07-17T00:00:02.000Z')
  `).run(goal.id, parentDatabaseId);
  db.prepare(`
    INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at)
    VALUES ('tampered-child-db', 'T1', 'Tampered', 'PASS',
      '2026-07-17T00:00:02.000Z', '2026-07-17T00:00:02.000Z')
  `).run();

  const result = evaluateManagedCompletion(db, { goalId: goal.id });

  assert.ok(result.gaps.some((gap) =>
    gap.type === "invalid_split_lineage" && gap.reasonCode === "frozen_child_set_mismatch"
      && gap.taskIds?.includes("tampered-child")
  ));
  db.close();
});

test("accepts a valid nested split through its accepted leaf closure", () => {
  const fixture = lineageFixture();
  const tasks = createManagedTaskRepository(fixture.db);
  fixture.db.prepare("UPDATE managed_tasks SET status = 'split' WHERE goal_id = ? AND logical_task_id = 'child'")
    .run(fixture.goalId);
  tasks.registerTasks({
    goalId: fixture.goalId,
    changeId: "change-a",
    tasks: [{ id: "grandchild", title: "Leaf", parentTaskId: "child", acceptance: [{ id: "G1", text: "Done" }] }],
  });
  fixture.db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS' WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'grandchild')")
    .run(fixture.goalId);
  fixture.db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id = 'grandchild'")
    .run(fixture.goalId);

  assert.deepEqual(evaluateManagedCompletion(fixture.db, { goalId: fixture.goalId }), { ok: true, gaps: [] });
  fixture.db.close();
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

function lineageFixture() {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({ title: "Lineage", description: "Shared projection" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{
      id: "parent",
      title: "Large",
      acceptance: [{ id: "P1", text: "One" }, { id: "P2", text: "Two" }, { id: "P3", text: "Three" }],
    }],
  });
  tasks.transition("parent", "split", { goalId: goal.id, safeSummary: "Narrowed" });
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-a",
    tasks: [{
      id: "child", title: "Narrow", parentTaskId: "parent",
      acceptance: [{ id: "C1", text: "One" }, { id: "C2", text: "Two" }],
    }],
  });
  db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS' WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'child')")
    .run(goal.id);
  db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id = 'child'")
    .run(goal.id);
  return { db, goalId: goal.id };
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
