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
import { createAgentLoopRuntime } from "./agent-loop-runtime.js";

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-loop-runtime-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const eventRepo = createEventRepository(db);
  return { db, goalRepo, runRepo, stepRepo, eventRepo };
}

test("agent loop persists planner decision and closes a direct step without a gate vote", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Ship the loop",
    description: "Plan, implement, and gate one direct step",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    planner: {
      async plan(input) {
        assert.equal(input.goal.id, goal.id);
        assert.deepEqual(input.priorSteps, []);
        return {
          decision: "IMPLEMENT_DIRECTLY",
          nextStep: "Write the first loop step",
          reason: "Small enough to do directly",
        };
      },
    },
    implementer: {
      async implement(input) {
        assert.equal(input.goal.id, goal.id);
        assert.equal(input.step, "Write the first loop step");
        return {
          step: input.step,
          result: "Implemented the first loop step",
        };
      },
    },
    gate: {
      async vote() {
        throw new Error("Gate should not run for direct implementation");
      },
    },
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "step.started",
      "agent.decision",
      "agent.message",
      "step.completed",
      "run.completed",
      "goal.completed",
    ],
  );
  const runId = events[0]?.runId;
  assert.ok(runId);
  assert.equal(runRepo.getById(runId)?.status, "completed");
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  const steps = stepRepo.listForRun(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.status, "completed");
  assert.equal(steps[0]?.result, "Implemented the first loop step");

  const decision = events.find((event) => event.type === "agent.decision");
  assert.deepEqual(decision?.data, {
    decision: "IMPLEMENT_DIRECTLY",
    nextStep: "Write the first loop step",
    reason: "Small enough to do directly",
  });

  const message = events.find((event) => event.type === "agent.message");
  assert.equal(message?.message, "Implemented the first loop step");
  assert.deepEqual(message?.data, {
    stepId: message?.stepId,
    role: "implementer",
    step: "Write the first loop step",
  });

  assert.equal(events.some((event) => event.type === "gate.voted"), false);
  assert.equal(events.some((event) => event.type === "scope.voted"), false);

  db.close();
});

test("agent loop stops decomposition at maxDepth and records a bounded terminal state", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Respect depth bounds",
    description: "Do not decompose past the configured depth",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    maxSteps: 3,
    maxDepth: 0,
    planner: {
      async plan() {
        return {
          decision: "DECOMPOSE",
          subSteps: ["First child step"],
          reason: "Needs a child step",
        };
      },
    },
    implementer: {
      async implement() {
        throw new Error("Implementer should not run when decomposition is bounded");
      },
    },
    gate: {
      async vote() {
        throw new Error("Gate should not run when decomposition is bounded");
      },
    },
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const runId = events[0]?.runId;
  assert.ok(runId);
  assert.equal(stepRepo.listForRun(runId).length, 0);
  assert.equal(events.some((event) => event.type === "agent.decision"), true);
  assert.equal(runRepo.getById(runId)?.status, "completed");
  assert.equal(goalRepo.getById(goal.id)?.status, "blocked");
  assert.deepEqual(events.at(-1)?.data, {
    goalId: goal.id,
    runId,
    terminalState: "bounded",
    bound: "maxDepth",
    maxDepth: 0,
  });

  db.close();
});

test("agent loop records a blocked terminal state when the planner blocks", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Ask for human input",
    description: "Planner cannot proceed safely",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    planner: {
      async plan() {
        return {
          decision: "BLOCKED",
          reason: "Need the user to choose the deployment target",
        };
      },
    },
    implementer: {
      async implement() {
        throw new Error("Implementer should not run for blocked planner decisions");
      },
    },
    gate: {
      async vote() {
        throw new Error("Gate should not run for blocked planner decisions");
      },
    },
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const runId = events[0]?.runId;
  assert.ok(runId);
  assert.equal(stepRepo.listForRun(runId).length, 0);
  assert.equal(runRepo.getById(runId)?.status, "completed");
  assert.equal(goalRepo.getById(goal.id)?.status, "blocked");
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "agent.decision", "run.completed", "goal.blocked"],
  );
  assert.deepEqual(events.at(-1)?.data, {
    goalId: goal.id,
    runId,
    terminalState: "blocked",
    reason: "Need the user to choose the deployment target",
  });

  db.close();
});
