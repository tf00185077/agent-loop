import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../persistence/database.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import {
  createEventRepository,
  createRunRepository,
  createStepRepository,
} from "../persistence/runtime-repositories.js";
import { createMockRuntime } from "./mock-runtime.js";

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-runtime-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const eventRepo = createEventRepository(db);
  const runtime = createMockRuntime({ goalRepo, runRepo, stepRepo, eventRepo });
  return { db, goalRepo, eventRepo, runtime };
}

test("happy path event timeline covers full lifecycle", async () => {
  const { db, goalRepo, eventRepo, runtime } = setup();

  const goal = goalRepo.create({ title: "Write tests", description: "Cover the runtime" });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const types = eventRepo.listForGoal(goal.id).map((e) => e.type);

  assert.ok(types.includes("run.started"), "missing run.started");
  assert.ok(types.includes("step.started"), "missing step.started");
  assert.ok(types.includes("agent.message"), "missing agent.message");
  assert.ok(types.includes("step.completed"), "missing step.completed");
  assert.ok(types.includes("run.completed"), "missing run.completed");
  assert.ok(types.includes("goal.completed"), "missing goal.completed");
  assert.equal(types.at(-1), "goal.completed", "last event must be goal.completed");

  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  db.close();
});

test("every started step has a matching step.completed — timeline is self-contained", async () => {
  const { db, goalRepo, eventRepo, runtime } = setup();

  const goal = goalRepo.create({ title: "Lifecycle goal", description: "Verify timeline" });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const types = eventRepo.listForGoal(goal.id).map((e) => e.type);

  const startCount = types.filter((t) => t === "step.started").length;
  const completeCount = types.filter((t) => t === "step.completed").length;
  assert.ok(startCount > 0, "at least one step must be recorded");
  assert.equal(startCount, completeCount, "every started step must have a matching step.completed");

  const last = types.at(-1);
  assert.ok(
    last === "goal.completed" || last === "goal.blocked",
    `terminal event must be goal.completed or goal.blocked, got: ${last}`,
  );

  db.close();
});

test("blocked path records goal.blocked and marks goal blocked", async () => {
  const { db, goalRepo, eventRepo, runtime } = setup();

  const goal = goalRepo.create({ title: "block this goal", description: "Should be blocked" });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const types = eventRepo.listForGoal(goal.id).map((e) => e.type);

  assert.ok(types.includes("run.started"), "missing run.started");
  assert.ok(types.includes("goal.blocked"), "missing goal.blocked");
  assert.ok(!types.includes("goal.completed"), "blocked path must not emit goal.completed");
  assert.equal(types.at(-1), "goal.blocked", "last event must be goal.blocked");

  assert.equal(goalRepo.getById(goal.id)?.status, "blocked");

  db.close();
});

test("throws if goal does not exist", async () => {
  const { db, runtime } = setup();

  await assert.rejects(() => runtime.run("nonexistent-id"), /Goal not found/);

  db.close();
});
