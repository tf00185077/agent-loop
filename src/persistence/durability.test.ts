import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";
import { createEventRepository, createRunRepository, createStepRepository } from "./runtime-repositories.js";

test("created goals and events survive database reopen", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-durable-")), "durable.sqlite");
  let goalId: string;

  {
    const db = openDatabase({ path: dbPath });
    const goals = createGoalRepository(db);
    const runs = createRunRepository(db);
    const steps = createStepRepository(db);
    const events = createEventRepository(db);

    const goal = goals.create({
      title: "Persist lifecycle",
      description: "Verify goal and timeline durability.",
      priority: "high",
      agentType: "general",
    });
    const run = runs.create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
    const step = steps.create({
      goalId: goal.id,
      runId: run.id,
      title: "Write durable event",
      description: "Create a persisted timeline entry.",
      order: 1,
    });

    events.create({
      goalId: goal.id,
      type: "goal.created",
      message: "Goal created.",
      data: { source: "test" },
    });
    events.create({
      goalId: goal.id,
      runId: run.id,
      stepId: step.id,
      type: "agent.message",
      message: "Still here after reopen.",
    });

    goalId = goal.id;
    db.close();
  }

  {
    const db = openDatabase({ path: dbPath });
    const goals = createGoalRepository(db);
    const events = createEventRepository(db);

    const goal = goals.getById(goalId);
    const timeline = events.listForGoal(goalId);

    assert.equal(goal?.title, "Persist lifecycle");
    assert.equal(goal?.status, "draft");
    assert.deepEqual(
      timeline.map((event) => event.type),
      ["goal.created", "agent.message"],
    );
    assert.deepEqual(timeline[0]?.data, { source: "test" });
    assert.deepEqual(timeline[1]?.data, {});
    assert.equal(timeline[1]?.message, "Still here after reopen.");

    db.close();
  }
});
