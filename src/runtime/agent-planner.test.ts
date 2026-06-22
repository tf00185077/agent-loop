import assert from "node:assert/strict";
import test from "node:test";

import type { Goal, Step } from "../domain/index.js";
import { buildPlannerPrompt, createPlanner } from "./agent-planner.js";
import type { ModelProvider } from "./model-provider.js";

const goal = {
  id: "goal-1",
  title: "Ship the loop",
  description: "Advance work one step at a time.",
  status: "running",
  priority: "normal",
  agentType: "general",
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
  startedAt: "2026-06-22T00:00:00.000Z",
  completedAt: null,
} satisfies Goal;

const priorSteps = [
  {
    id: "step-1",
    goalId: "goal-1",
    runId: "run-1",
    title: "Inspect current runtime",
    description: "Read provider runtime and persistence code.",
    status: "completed",
    order: 1,
    result: "Provider runtime is single-shot.",
    createdAt: "2026-06-22T00:01:00.000Z",
    updatedAt: "2026-06-22T00:02:00.000Z",
  },
] satisfies Step[];

test("buildPlannerPrompt includes the goal, prior persisted steps, and output convention", () => {
  const prompt = buildPlannerPrompt({ goal, priorSteps });

  assert.match(prompt, /Title: Ship the loop/);
  assert.match(prompt, /Description: Advance work one step at a time\./);
  assert.match(prompt, /1\. Inspect current runtime/);
  assert.match(prompt, /Result: Provider runtime is single-shot\./);
  assert.match(prompt, /DECISION: IMPLEMENT_DIRECTLY\|DECOMPOSE\|NEEDS_OPENSPEC\|BLOCKED/);
  assert.match(prompt, /NEXT_STEP:/);
  assert.match(prompt, /SUB_STEPS:/);
  assert.match(prompt, /REASON:/);
});

test("planner calls the provider without session state and parses a direct step", async () => {
  let seenPrompt = "";
  let seenConversationState: unknown = "not-called";
  const provider: ModelProvider = {
    async complete(input) {
      seenPrompt = input.prompt;
      seenConversationState = input.conversationState;
      return {
        text: [
          "DECISION: IMPLEMENT_DIRECTLY",
          "NEXT_STEP: Add the planner module",
          "REASON: This is a small isolated runtime piece.",
        ].join("\n"),
        metadata: { provider: "codex-local", model: "codex" },
      };
    },
  };

  const planner = createPlanner({ provider });
  const result = await planner.plan({ goal, priorSteps });

  assert.equal(seenConversationState, undefined);
  assert.match(seenPrompt, /Provider runtime is single-shot\./);
  assert.deepEqual(result, {
    decision: "IMPLEMENT_DIRECTLY",
    nextStep: "Add the planner module",
    reason: "This is a small isolated runtime piece.",
  });
});

test("planner defaults malformed provider output to blocked with raw output", async () => {
  const rawOutput = "I think we should probably keep going, but I forgot the format.";
  const provider: ModelProvider = {
    async complete() {
      return {
        text: rawOutput,
        metadata: { provider: "codex-local", model: "codex" },
      };
    },
  };

  const planner = createPlanner({ provider });
  const result = await planner.plan({ goal, priorSteps: [] });

  assert.deepEqual(result, {
    decision: "BLOCKED",
    reason: "Planner output could not be parsed: Missing planner output line: DECISION:",
    rawOutput,
  });
});
