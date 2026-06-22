import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";
import { createEventBus } from "./event-bus.js";
import { createEventRepository, createRunRepository, createStepRepository } from "./runtime-repositories.js";

test("creates and updates run records for a goal", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Runtime goal",
    description: "Exercise run persistence.",
  });
  const runs = createRunRepository(db);

  const run = runs.create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
  const completed = runs.updateStatus(run.id, "completed", {
    finishedAt: "2026-06-15T09:00:00.000Z",
  });

  assert.equal(run.goalId, goal.id);
  assert.equal(run.status, "running");
  assert.equal(completed.status, "completed");
  assert.equal(completed.finishedAt, "2026-06-15T09:00:00.000Z");
  assert.deepEqual(runs.getById(run.id), completed);
  assert.equal(runs.getById("missing"), null);

  db.close();
});

test("creates, updates, and lists step records for a run", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Step goal",
    description: "Exercise step persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
  const steps = createStepRepository(db);

  const second = steps.create({
    goalId: goal.id,
    runId: run.id,
    title: "Second step",
    description: "Runs second.",
    order: 2,
  });
  const first = steps.create({
    goalId: goal.id,
    runId: run.id,
    title: "First step",
    description: "Runs first.",
    order: 1,
  });
  const completed = steps.update(first.id, { status: "completed", result: "Done" });

  assert.equal(first.status, "pending");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "Done");
  assert.deepEqual(
    steps.listForRun(run.id).map((step) => step.id),
    [first.id, second.id],
  );
  assert.throws(() => steps.update("missing", { status: "running" }), /Step not found/);

  db.close();
});

test("creates and lists event records for a goal timeline", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Event goal",
    description: "Exercise event persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
  const step = createStepRepository(db).create({
    goalId: goal.id,
    runId: run.id,
    title: "Mock step",
    description: "Produces an event.",
    order: 1,
  });
  const events = createEventRepository(db);

  const started = events.create({
    goalId: goal.id,
    runId: run.id,
    type: "run.started",
    message: "Run started.",
    data: { provider: "mock" },
  });
  const message = events.create({
    goalId: goal.id,
    runId: run.id,
    stepId: step.id,
    type: "agent.message",
    message: "Working on the goal.",
  });

  assert.equal(started.stepId, null);
  assert.deepEqual(started.data, { provider: "mock" });
  assert.deepEqual(message.data, {});
  assert.deepEqual(
    events.listForGoal(goal.id).map((event) => event.id),
    [started.id, message.id],
  );

  db.close();
});

test("publishes each event to the event bus after it is durably persisted", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Published goal",
    description: "Exercise event publication.",
  });
  const bus = createEventBus();
  const received: unknown[] = [];
  bus.subscribe(goal.id, (event) => received.push(event));
  const events = createEventRepository(db, { eventBus: bus });

  const created = events.create({
    goalId: goal.id,
    type: "goal.created",
    message: "Goal created.",
  });

  assert.deepEqual(events.listForGoal(goal.id), [created]);
  assert.deepEqual(received, [created]);

  db.close();
});

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "auto-agent-runtime-")), "runtime.sqlite");
}
