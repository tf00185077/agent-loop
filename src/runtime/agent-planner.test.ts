import assert from "node:assert/strict";
import test from "node:test";

import type { Goal, Step } from "../domain/index.js";
import { buildPlannerPrompt, createPlanner, parsePlannerOutput } from "./agent-planner.js";
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
  assert.match(prompt, /SCOPE: ready\|too_large\|too_small/);
  assert.match(prompt, /NEXT_STEP:/);
  assert.match(prompt, /SUB_STEPS:/);
  assert.match(prompt, /REASON:/);
});

test("buildPlannerPrompt includes bounded scope refinement context", () => {
  const prompt = buildPlannerPrompt({
    goal,
    priorSteps,
    scopeRefinementContext: {
      assessmentAttempt: 2,
      refinementRound: 1,
      previousPlannerReason: "The work spans planner, voter, and runtime changes.",
      previousVoterReason: "Two voters agreed the task still crosses too many modules.",
    },
  });

  assert.match(prompt, /Scope refinement context/);
  assert.match(prompt, /Assessment attempt: 2/);
  assert.match(prompt, /Refinement round: 1/);
  assert.match(prompt, /Previous planner reason: The work spans planner, voter, and runtime changes\./);
  assert.match(prompt, /Previous voter reason: Two voters agreed the task still crosses too many modules\./);
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

test("parsePlannerOutput parses IMPLEMENT_DIRECTLY", () => {
  assert.deepEqual(
    parsePlannerOutput(
      [
        "DECISION: IMPLEMENT_DIRECTLY",
        "NEXT_STEP: Write the loop orchestrator",
        "REASON: The next direct step is small enough.",
      ].join("\n"),
    ),
    {
      decision: "IMPLEMENT_DIRECTLY",
      nextStep: "Write the loop orchestrator",
      reason: "The next direct step is small enough.",
    },
  );
});

test("parsePlannerOutput parses DECOMPOSE", () => {
  assert.deepEqual(
    parsePlannerOutput(
      [
        "DECISION: DECOMPOSE",
        "SUB_STEPS:",
        "- Add planner",
        "- Add implementer",
        "REASON: The work has separable parts.",
      ].join("\n"),
    ),
    {
      decision: "DECOMPOSE",
      subSteps: ["Add planner", "Add implementer"],
      reason: "The work has separable parts.",
    },
  );
});

test("parsePlannerOutput parses DECOMPOSE with a too-large scope assessment", () => {
  assert.deepEqual(
    parsePlannerOutput(
      [
        "DECISION: DECOMPOSE",
        "SCOPE: too_large",
        "SUB_STEPS:",
        "- Split planner context",
        "- Split scope voting",
        "REASON: The current task is too broad for one implementer.",
      ].join("\n"),
    ),
    {
      decision: "DECOMPOSE",
      scopeAssessment: "too_large",
      subSteps: ["Split planner context", "Split scope voting"],
      reason: "The current task is too broad for one implementer.",
    },
  );
});

test("parsePlannerOutput parses IMPLEMENT_DIRECTLY with a too-small scope assessment", () => {
  assert.deepEqual(
    parsePlannerOutput(
      [
        "DECISION: IMPLEMENT_DIRECTLY",
        "SCOPE: too_small",
        "NEXT_STEP: Apply the one-line event type update",
        "REASON: The task is tiny enough to proceed without refinement.",
      ].join("\n"),
    ),
    {
      decision: "IMPLEMENT_DIRECTLY",
      scopeAssessment: "too_small",
      nextStep: "Apply the one-line event type update",
      reason: "The task is tiny enough to proceed without refinement.",
    },
  );
});

test("parsePlannerOutput parses NEEDS_OPENSPEC", () => {
  assert.deepEqual(
    parsePlannerOutput(
      [
        "DECISION: NEEDS_OPENSPEC",
        "REASON: The requested behavior changes the planned capability.",
      ].join("\n"),
    ),
    {
      decision: "NEEDS_OPENSPEC",
      reason: "The requested behavior changes the planned capability.",
    },
  );
});

test("parsePlannerOutput parses BLOCKED", () => {
  assert.deepEqual(
    parsePlannerOutput(
      [
        "DECISION: BLOCKED",
        "REASON: A human needs to choose an affected area.",
      ].join("\n"),
    ),
    {
      decision: "BLOCKED",
      reason: "A human needs to choose an affected area.",
    },
  );
});

test("parsePlannerOutput treats unsupported decisions as blocked with raw output", () => {
  const rawOutput = [
    "DECISION: WAIT",
    "REASON: This is not part of the closed decision set.",
  ].join("\n");

  assert.deepEqual(parsePlannerOutput(rawOutput), {
    decision: "BLOCKED",
    reason: "Planner output could not be parsed: Unsupported planner decision: WAIT",
    rawOutput,
  });
});
