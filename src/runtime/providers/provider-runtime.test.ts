import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import {
  createEventRepository,
  createRunRepository,
  createStepRepository,
} from "../../persistence/runtime-repositories.js";
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

  assert.ok(output);
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

test("provider runtime records happy-path lifecycle events in order", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete() {
        return {
          text: "Provider lifecycle response",
          metadata: { provider: "fake", model: "fake-model" },
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "Verify provider lifecycle",
    description: "Record all happy-path events",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  assert.deepEqual(
    eventRepo.listForGoal(goal.id).map((event) => event.type),
    [
      "run.started",
      "step.started",
      "agent.message",
      "step.completed",
      "run.completed",
      "goal.completed",
    ],
  );

  db.close();
});

test("provider runtime persists provider and model metadata in run and message event", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete() {
        return {
          text: "Provider metadata response",
          metadata: { provider: "codex-cli", model: "gpt-5-codex-subscription" },
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "Verify provider metadata",
    description: "Persist provider identity",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const runId = events.find((event) => event.type === "run.started")?.runId;
  assert.ok(runId, "run.started event must include runId");
  const run = runRepo.getById(runId);
  assert.equal(run?.provider, "codex-cli");
  assert.equal(run?.model, "gpt-5-codex-subscription");

  const message = events.find((event) => event.type === "agent.message");
  assert.deepEqual(message?.data, {
    stepId: message?.stepId,
    provider: "codex-cli",
    model: "gpt-5-codex-subscription",
  });

  db.close();
});

test("provider runtime records provider errors and marks run and goal failed", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete() {
        throw new Error("provider exploded");
      },
    },
  });
  const goal = goalRepo.create({
    title: "Handle provider failure",
    description: "Persist failed runtime state",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const error = events.find((event) => event.type === "error");
  assert.equal(error?.message, "provider exploded");
  assert.ok(error?.runId, "error event must include runId");
  const run = runRepo.getById(error.runId);
  assert.equal(run?.status, "failed");
  assert.equal(run?.error, "provider exploded");
  assert.equal(goalRepo.getById(goal.id)?.status, "failed");

  db.close();
});

test("provider runtime records known provider metadata on error events without credentials", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      metadata: { provider: "codex-cli", model: "gpt-5-codex" },
      async complete() {
        throw new Error("provider exploded");
      },
    },
  });
  const goal = goalRepo.create({
    title: "Handle known provider failure",
    description: "Persist display-safe provider metadata",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  await runtime.run(goal.id);

  const error = eventRepo.listForGoal(goal.id).find((event) => event.type === "error");
  assert.ok(error?.runId, "error event must include runId");
  assert.deepEqual(error.data, {
    runId: error.runId,
    provider: "codex-cli",
    model: "gpt-5-codex",
  });
  const serializedData = JSON.stringify(error.data);
  assert.equal(serializedData.includes("commandPath"), false);
  assert.equal(serializedData.includes("apiKey"), false);
  assert.equal(serializedData.includes("Authorization"), false);

  const run = runRepo.getById(error.runId);
  assert.equal(run?.provider, "codex-cli");
  assert.equal(run?.model, "gpt-5-codex");

  db.close();
});

test("provider runtime forwards conversation state verbatim and surfaces the returned value", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const incomingState = { sessionId: "abc-123", nested: { resume: true } };
  const returnedState = { sessionId: "abc-456" };
  const receivedInputs: ModelProviderInput[] = [];
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete(input: ModelProviderInput) {
        receivedInputs.push(input);
        return {
          text: "Continued response",
          metadata: { provider: "fake", model: "fake-model" },
          conversationState: returnedState,
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "Continue a session",
    description: "Thread conversation state through",
  });

  const output = await runtime.run(goal.id, { conversationState: incomingState });

  assert.equal(receivedInputs.length, 1);
  assert.strictEqual(receivedInputs[0]?.conversationState, incomingState);
  assert.strictEqual(output?.conversationState, returnedState);

  db.close();
});

test("provider runtime tolerates absent conversation state", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  let received: ModelProviderInput | undefined;
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete(input: ModelProviderInput) {
        received = input;
        return {
          text: "Fresh response",
          metadata: { provider: "fake", model: "fake-model" },
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "Start fresh",
    description: "No conversation state supplied",
  });

  const output = await runtime.run(goal.id);

  assert.equal(received?.conversationState, undefined);
  assert.equal(output?.conversationState, undefined);

  db.close();
});

test("provider runtime persists sanitized progress chunks as durable agent.progress events", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      metadata: { provider: "fake-cli", model: "fake-model" },
      async complete(input: ModelProviderInput) {
        input.onProgress?.("Analyzing the goal...");
        input.onProgress?.("Drafting a plan...");
        return {
          text: "Final response",
          metadata: { provider: "fake-cli", model: "fake-model" },
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "Stream progress",
    description: "Persist progress chunks as durable events",
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const progressEvents = events.filter((event) => event.type === "agent.progress");
  assert.deepEqual(
    progressEvents.map((event) => event.message),
    ["Analyzing the goal...", "Drafting a plan..."],
  );
  assert.deepEqual(progressEvents[0]?.data, { provider: "fake-cli" });

  const finalMessageIndex = events.findIndex((event) => event.type === "agent.message");
  const lastProgressIndex = events.findIndex(
    (event) => event === progressEvents[progressEvents.length - 1],
  );
  assert.ok(lastProgressIndex < finalMessageIndex, "progress events must precede the final result");

  db.close();
});

test("provider runtime ignores empty or whitespace-only progress chunks", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      async complete(input: ModelProviderInput) {
        input.onProgress?.("   ");
        input.onProgress?.("");
        return {
          text: "Final response",
          metadata: { provider: "fake", model: "fake-model" },
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "No-op progress",
    description: "Empty chunks must not create events",
  });

  await runtime.run(goal.id);

  const progressEvents = eventRepo.listForGoal(goal.id).filter((event) => event.type === "agent.progress");
  assert.equal(progressEvents.length, 0);

  db.close();
});

test("provider runtime redacts secret-like progress chunks before persisting and streaming", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const runtime = createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider: {
      metadata: { provider: "fake-cli", model: "fake-model" },
      async complete(input: ModelProviderInput) {
        input.onProgress?.("Authorization: Bearer sk-abcdefghijklmnop");
        input.onProgress?.("codex --api-key supersecretvalue exec");
        return {
          text: "Final response",
          metadata: { provider: "fake-cli", model: "fake-model" },
        };
      },
    },
  });
  const goal = goalRepo.create({
    title: "Redact secrets",
    description: "Secret-bearing progress output must be sanitized",
  });

  await runtime.run(goal.id);

  const progressEvents = eventRepo.listForGoal(goal.id).filter((event) => event.type === "agent.progress");
  const serialized = JSON.stringify(progressEvents);
  assert.equal(serialized.includes("sk-abcdefghijklmnop"), false);
  assert.equal(serialized.includes("supersecretvalue"), false);
  assert.ok(progressEvents.every((event) => event.message.includes("[redacted]")));

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
