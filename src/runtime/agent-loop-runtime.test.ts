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

test("agent loop persists planner decision, implementer result, and gate vote for a direct step", async () => {
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
      async vote(input) {
        assert.equal(input.goal.id, goal.id);
        assert.equal(input.step.title, "Write the first loop step");
        assert.equal(input.implementation.result, "Implemented the first loop step");
        return {
          proposition: "Does the current result satisfy the goal?",
          decision: "done",
          isDone: true,
          tally: {
            done: 2,
            notDone: 1,
            abstain: 0,
            total: 3,
            majorityReached: true,
          },
          ballots: [
            {
              voterId: "codex-local",
              providerKind: "codex-local",
              decision: "done",
              reason: "The result is acceptable",
            },
            {
              voterId: "claude-local",
              providerKind: "claude-local",
              decision: "done",
              reason: "The result is complete",
            },
            {
              voterId: "openai-compatible",
              providerKind: "openai-compatible",
              decision: "not_done",
              reason: "Could use more detail",
            },
          ],
        };
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
      "gate.voted",
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

  const vote = events.find((event) => event.type === "gate.voted");
  assert.equal(vote?.data.decision, "done");
  assert.equal(vote?.data.isDone, true);
  assert.equal((vote?.data.ballots as unknown[]).length, 3);

  db.close();
});
