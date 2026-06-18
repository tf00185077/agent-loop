import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOpenAILocalAgentProvider } from "./openai-local-agent-provider.js";

function createFakeAgentScript(dir: string): string {
  const scriptPath = join(dir, "fake-openai-local-agent.mjs");
  writeFileSync(
    scriptPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.argv[2];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const input = JSON.parse(stdin);
  writeFileSync(capturePath, JSON.stringify(input));
  process.stdout.write(JSON.stringify({ text: "Fake local agent response" }));
});
`.trimStart(),
  );
  return scriptPath;
}

test("spawns configured command, sends prompt, and extracts response text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-openai-local-provider-"));
  const capturePath = join(dir, "captured-input.json");
  const scriptPath = createFakeAgentScript(dir);
  const provider = createOpenAILocalAgentProvider({
    config: {
      provider: "openai-local-agent",
      command: "node",
      args: [scriptPath, capturePath],
      model: "gpt-5-codex-subscription",
      timeoutMs: 10_000,
    },
  });

  const output = await provider.complete({
    goal: {
      id: "goal-1",
      title: "Write a smoke test",
      description: "Verify local provider IO",
    },
    prompt: "Complete this goal with one concise response.",
  });

  assert.deepEqual(output, {
    text: "Fake local agent response",
    metadata: {
      provider: "openai-local-agent",
      model: "gpt-5-codex-subscription",
    },
  });

  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(captured.goal, {
    id: "goal-1",
    title: "Write a smoke test",
    description: "Verify local provider IO",
  });
  assert.equal(captured.prompt, "Complete this goal with one concise response.");
});
