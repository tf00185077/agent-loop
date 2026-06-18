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
import type { ModelProviderInput } from "./model-provider.js";
import { createProviderRuntime } from "./provider-runtime.js";

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-provider-runtime-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const eventRepo = createEventRepository(db);
  return { db, goalRepo, runRepo, stepRepo, eventRepo };
}

test("runtime can use an injected fake provider", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const receivedInputs: ModelProviderInput[] = [];
  const provider = {
    async complete(input: ModelProviderInput) {
      receivedInputs.push(input);
      return {
        text: "Fake provider response",
        metadata: { provider: "fake", model: "fake-model" },
      };
    },
  };
  const runtime = createProviderRuntime({ goalRepo, runRepo, stepRepo, eventRepo, provider });
  const goal = goalRepo.create({
    title: "Write the smoke test",
    description: "Prove provider injection works",
  });

  const output = await runtime.run(goal.id);

  assert.equal(output.text, "Fake provider response");
  assert.deepEqual(output.metadata, { provider: "fake", model: "fake-model" });
  assert.equal(receivedInputs.length, 1);
  const receivedInput = receivedInputs[0];
  assert.deepEqual(receivedInput?.goal, {
    id: goal.id,
    title: "Write the smoke test",
    description: "Prove provider injection works",
  });
  assert.match(receivedInput?.prompt ?? "", /Write the smoke test/);

  db.close();
});

test("provider runtime creates one durable step and records provider response", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const provider = {
    async complete(input: ModelProviderInput) {
      assert.equal(input.goal.title, "Summarize the plan");
      return {
        text: "Provider completed the smoke step",
        metadata: { provider: "fake", model: "fake-model" },
      };
    },
  };
  const runtime = createProviderRuntime({ goalRepo, runRepo, stepRepo, eventRepo, provider });
  const goal = goalRepo.create({
    title: "Summarize the plan",
    description: "Use the provider runtime",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const runId = events.find((event) => event.type === "run.started")?.runId;
  assert.ok(runId, "run.started event must include runId");
  const run = runRepo.getById(runId);
  assert.equal(run?.status, "completed");
  assert.equal(run?.provider, "fake");
  assert.equal(run?.model, "fake-model");

  const steps = stepRepo.listForRun(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.status, "completed");
  assert.equal(steps[0]?.result, "Provider completed the smoke step");

  const message = events.find((event) => event.type === "agent.message");
  assert.equal(message?.message, "Provider completed the smoke step");
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  db.close();
});

test("provider runtime throws if goal does not exist", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete() {
        throw new Error("Provider should not be called");
      },
    },
  });

  await assert.rejects(() => runtime.run("missing-goal"), /Goal not found: missing-goal/);

  db.close();
});
