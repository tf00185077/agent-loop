import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";

test("creates, lists, and gets persisted goals", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goals = createGoalRepository(db);

  const first = goals.create({
    title: "Plan the MVP",
    description: "Define the first local lifecycle.",
    priority: "high",
    agentType: "general",
  });
  const second = goals.create({
    title: "Write release notes",
    description: "Summarize the vertical slice.",
  });

  assert.equal(first.status, "draft");
  assert.equal(first.priority, "high");
  assert.equal(first.agentType, "general");
  assert.equal(first.startedAt, null);
  assert.equal(first.completedAt, null);
  assert.match(first.id, /^[0-9a-f-]{36}$/);

  assert.deepEqual(
    goals.list().map((goal) => goal.id),
    [second.id, first.id],
  );
  assert.deepEqual(goals.getById(first.id), first);
  assert.equal(goals.getById("missing"), null);

  db.close();
});

test("updates goal lifecycle status and timestamps", () => {
  const db = openDatabase({ path: testDatabasePath() });
  // Deterministic, strictly increasing clock so updatedAt is guaranteed to
  // differ from the created timestamp (avoids same-millisecond flakiness).
  let tick = 0;
  const goals = createGoalRepository(db, {
    now: () => new Date(Date.UTC(2026, 5, 15, 8, 0, tick++)).toISOString(),
  });
  const goal = goals.create({
    title: "Run lifecycle",
    description: "Move through runtime status changes.",
  });

  const running = goals.updateStatus(goal.id, "running", { startedAt: "2026-06-15T08:00:00.000Z" });
  const completed = goals.updateStatus(goal.id, "completed", { completedAt: "2026-06-15T08:05:00.000Z" });

  assert.equal(running.status, "running");
  assert.equal(running.startedAt, "2026-06-15T08:00:00.000Z");
  assert.equal(completed.status, "completed");
  assert.equal(completed.startedAt, "2026-06-15T08:00:00.000Z");
  assert.equal(completed.completedAt, "2026-06-15T08:05:00.000Z");
  assert.notEqual(completed.updatedAt, goal.updatedAt);
  assert.throws(() => goals.updateStatus("missing", "running"), /Goal not found/);

  db.close();
});

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "auto-agent-goals-")), "goals.sqlite");
}
