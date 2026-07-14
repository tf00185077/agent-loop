import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
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
  db.prepare(`
    UPDATE managed_tasks SET attempt_count = 2, substantive_rejection_count = 1,
      last_cited_criteria = '["A1"]', last_safe_summary = ? WHERE id = 'task-1'
  `).run("x".repeat(900));
  const before = projectManagedTaskContext(tasks, goal.id);
  assert.equal(before[0]?.lastSafeSummary.length, 500);
  assert.deepEqual(before[0]?.criteria, [{ id: "A1", text: "Pass", outcome: "UNKNOWN" }]);
  db.close();

  db = openDatabase({ path });
  const after = projectManagedTaskContext(createManagedTaskRepository(db), goal.id);
  assert.deepEqual(after, before);
  db.close();
});
