import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClaudeCliProvider } from "./claude-cli-provider.js";
import type { ModelProviderInput } from "./model-provider.js";

const skipOnWindows = { skip: process.platform === "win32" };

const input: ModelProviderInput = {
  goal: { id: "goal-1", title: "Do the thing", description: null },
  prompt: "Reply exactly once.",
};

test("provider exposes display metadata before execution without command details", () => {
  const provider = createClaudeCliProvider({
    config: {
      commandPath: "C:\\secret\\claude.cmd --token hidden",
      modelLabel: "claude-sonnet-4-6",
    },
  });

  assert.deepEqual(provider.metadata, { provider: "claude-cli", model: "claude-sonnet-4-6" });
  const serializedMetadata = JSON.stringify(provider.metadata);
  assert.equal(serializedMetadata.includes("commandPath"), false);
  assert.equal(serializedMetadata.includes("secret"), false);
  assert.equal(serializedMetadata.includes("token"), false);
});

/**
 * Writes an executable fake `claude` that captures argv + stdin to capturePath
 * and prints `response` to stdout (mirroring `claude --print --output-format
 * text`). Returned path is used directly as the provider command.
 */
function fakeClaude(response: string, capturePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-claude-provider-test-"));
  const scriptPath = join(dir, "fake-claude.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
  process.stdout.write(${JSON.stringify(response)});
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function readCapture(capturePath: string): { args: string[]; stdin: string } {
  return JSON.parse(readFileSync(capturePath, "utf8"));
}

test("provider spawns claude --print and returns the stdout text", skipOnWindows, async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-claude-cap-")), "cap.json");
  const provider = createClaudeCliProvider({
    config: {
      commandPath: fakeClaude("  claude direct response\n", capturePath),
      modelLabel: "claude-sonnet-4-6",
      timeoutMs: 10_000,
    },
  });

  const output = await provider.complete(input);

  assert.equal(output.text, "claude direct response");
  assert.equal(output.metadata.provider, "claude-cli");
  assert.equal(output.metadata.model, "claude-sonnet-4-6");
  assert.equal(output.conversationState, undefined);
  const captured = readCapture(capturePath);
  assert.equal(captured.stdin, "Reply exactly once.");
  assert.ok(captured.args.includes("--print"));
  assert.equal(captured.args[captured.args.indexOf("--output-format") + 1], "text");
  const modelIndex = captured.args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(captured.args[modelIndex + 1], "claude-sonnet-4-6");
});

test("provider forwards stdout chunks to onProgress while still returning the final text", skipOnWindows, async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-claude-cap-")), "cap.json");
  const provider = createClaudeCliProvider({
    config: {
      commandPath: fakeClaude("claude direct response", capturePath),
      modelLabel: "claude-sonnet-4-6",
      timeoutMs: 10_000,
    },
  });
  const progressChunks: string[] = [];

  const output = await provider.complete({ ...input, onProgress: (chunk) => progressChunks.push(chunk) });

  assert.equal(output.text, "claude direct response");
  assert.ok(progressChunks.join("").includes("claude direct response"));
});

test("provider omits --model for a blank label and reports claude-default", skipOnWindows, async () => {
  for (const label of [null, "", "   "]) {
    const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-claude-cap-")), "cap.json");
    const provider = createClaudeCliProvider({
      config: { commandPath: fakeClaude("default model response", capturePath), modelLabel: label, timeoutMs: 10_000 },
    });

    const output = await provider.complete(input);

    assert.equal(output.text, "default model response");
    assert.equal(output.metadata.model, "claude-default");
    assert.equal(readCapture(capturePath).args.includes("--model"), false, `label=${String(label)}`);
  }
});

test("provider maps non-zero exit to a provider error", skipOnWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-claude-fail-"));
  const scriptPath = join(dir, "failing-claude.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => { process.stderr.write("boom"); process.exit(2); });
`,
  );
  chmodSync(scriptPath, 0o755);
  const provider = createClaudeCliProvider({
    config: { commandPath: scriptPath, modelLabel: null, timeoutMs: 10_000 },
  });

  await assert.rejects(() => provider.complete(input), /Claude CLI exited with code 2: boom/);
});

test("provider rejects an empty command path", async () => {
  const provider = createClaudeCliProvider({ config: { commandPath: "  ", modelLabel: null } });
  await assert.rejects(() => provider.complete(input), /Claude command path is required/);
});

test("provider rejects an empty claude response", skipOnWindows, async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-claude-cap-")), "cap.json");
  const provider = createClaudeCliProvider({
    config: { commandPath: fakeClaude("   \n", capturePath), modelLabel: null, timeoutMs: 10_000 },
  });

  await assert.rejects(() => provider.complete(input), /Claude CLI returned an empty response/);
});
