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

function createScript(dir: string, name: string, source: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, source.trimStart());
  return scriptPath;
}

function createProvider(config: {
  command: string;
  args?: string[];
  timeoutMs?: number;
}) {
  return createOpenAILocalAgentProvider({
    config: {
      provider: "openai-local-agent",
      command: config.command,
      args: config.args ?? [],
      model: "gpt-5-codex-subscription",
      timeoutMs: config.timeoutMs ?? 10_000,
    },
  });
}

const sampleInput = {
  goal: {
    id: "goal-1",
    title: "Write a smoke test",
    description: "Verify local provider IO",
  },
  prompt: "Complete this goal with one concise response.",
};

test("spawns configured command, sends prompt, and extracts response text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-openai-local-provider-"));
  const capturePath = join(dir, "captured-input.json");
  const scriptPath = createFakeAgentScript(dir);
  const provider = createProvider({ command: "node", args: [scriptPath, capturePath] });

  const output = await provider.complete(sampleInput);

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

test("fails when command is missing", async () => {
  const provider = createProvider({ command: "" });

  await assert.rejects(
    () => provider.complete(sampleInput),
    /AUTO_AGENT_OPENAI_LOCAL_COMMAND is required/,
  );
});

test("fails when local command exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-openai-local-provider-"));
  const scriptPath = createScript(
    dir,
    "exit-non-zero.mjs",
    `
process.stderr.write("simulated failure");
process.exit(42);
`,
  );
  const provider = createProvider({ command: "node", args: [scriptPath] });

  await assert.rejects(
    () => provider.complete(sampleInput),
    /OpenAI local agent exited with code 42: simulated failure/,
  );
});

test("fails when local command times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-openai-local-provider-"));
  const scriptPath = createScript(
    dir,
    "timeout.mjs",
    `
setTimeout(() => {}, 10_000);
`,
  );
  const provider = createProvider({ command: "node", args: [scriptPath], timeoutMs: 50 });

  await assert.rejects(
    () => provider.complete(sampleInput),
    /OpenAI local agent command timed out/,
  );
});

test("fails when local command outputs malformed JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-openai-local-provider-"));
  const scriptPath = createScript(
    dir,
    "malformed-output.mjs",
    `
process.stdout.write("not json");
`,
  );
  const provider = createProvider({ command: "node", args: [scriptPath] });

  await assert.rejects(
    () => provider.complete(sampleInput),
    /OpenAI local agent output must be JSON/,
  );
});

test("fails when local command output has no response text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-openai-local-provider-"));
  const scriptPath = createScript(
    dir,
    "missing-text.mjs",
    `
process.stdout.write(JSON.stringify({ text: "" }));
`,
  );
  const provider = createProvider({ command: "node", args: [scriptPath] });

  await assert.rejects(
    () => provider.complete(sampleInput),
    /OpenAI local agent output must include non-empty text/,
  );
});
