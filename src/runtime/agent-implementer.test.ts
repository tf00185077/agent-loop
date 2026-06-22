import assert from "node:assert/strict";
import test from "node:test";

import type { Goal } from "../domain/index.js";
import { buildImplementerPrompt, createImplementer } from "./agent-implementer.js";
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

test("buildImplementerPrompt describes a text-only direct step", () => {
  const prompt = buildImplementerPrompt({
    goal,
    step: "Summarize the runtime boundary",
  });

  assert.match(prompt, /Title: Ship the loop/);
  assert.match(prompt, /Description: Advance work one step at a time\./);
  assert.match(prompt, /Direct step:/);
  assert.match(prompt, /Summarize the runtime boundary/);
  assert.match(prompt, /Do not modify files or run commands/);
});

test("implementer calls provider without session state and returns text result", async () => {
  let seenPrompt = "";
  let seenConversationState: unknown = "not-called";
  const provider: ModelProvider = {
    async complete(input) {
      seenPrompt = input.prompt;
      seenConversationState = input.conversationState;
      return {
        text: "Documented the runtime boundary in plain text.",
        metadata: { provider: "codex-local", model: "codex" },
      };
    },
  };

  const implementer = createImplementer({ provider });
  const result = await implementer.implement({
    goal,
    step: "Summarize the runtime boundary",
  });

  assert.equal(seenConversationState, undefined);
  assert.match(seenPrompt, /Summarize the runtime boundary/);
  assert.deepEqual(result, {
    step: "Summarize the runtime boundary",
    result: "Documented the runtime boundary in plain text.",
  });
});
