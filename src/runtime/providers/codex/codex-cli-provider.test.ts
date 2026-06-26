import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv0 } from "node:process";
import test from "node:test";

import type { AgentObservation } from "../../../domain/index.js";
import { createCodexCliProvider } from "./codex-cli-provider.js";
import type { ModelProviderInput } from "../model-provider.js";

const skipOnWindows = { skip: process.platform === "win32" };

const input: ModelProviderInput = {
  goal: { id: "goal-1", title: "Do the thing", description: null },
  prompt: "Reply exactly once.",
};

test("provider exposes display metadata before execution without command details", () => {
  const provider = createCodexCliProvider({
    config: {
      commandPath: "C:\\secret\\codex.cmd --token hidden",
      modelLabel: "gpt-5-codex",
    },
  });

  assert.deepEqual(provider.metadata, { provider: "codex-cli", model: "gpt-5-codex" });
  const serializedMetadata = JSON.stringify(provider.metadata);
  assert.equal(serializedMetadata.includes("commandPath"), false);
  assert.equal(serializedMetadata.includes("secret"), false);
  assert.equal(serializedMetadata.includes("token"), false);
});

/**
 * Writes an executable fake `codex` that captures argv + stdin to capturePath
 * and writes `response` to the `--output-last-message` file. Returned path is
 * used directly as the provider command, so the provider's own arg building
 * (`exec`, `--model`, `-`) is exercised end to end.
 */
function fakeCodex(response: string, capturePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-provider-test-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], ${JSON.stringify(response)});
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function readCapture(capturePath: string): { args: string[]; stdin: string } {
  return JSON.parse(readFileSync(capturePath, "utf8"));
}

function commandPathForScript(scriptPath: string, commandName: string): string {
  if (process.platform !== "win32") return scriptPath;
  const commandPath = join(scriptPath, "..", `${commandName}.cmd`);
  writeFileSync(commandPath, `@echo off\r\n"${argv0}" "${scriptPath}" %*\r\n`);
  return commandPath;
}

function fakeCodexWithJsonl(capturePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-jsonl-test-"));
  const scriptPath = join(dir, "fake-codex-jsonl.mjs");
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
  process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command", command: "npm test" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command", command: "npm test", exit_code: 0, stdout: "ok" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_message", message: "json final answer" }) + "\\n");
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return commandPathForScript(scriptPath, "fake-codex-jsonl");
}

function fakeCodexWithJsonlAndLastMessageFallback(capturePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-jsonl-last-message-test-"));
  const scriptPath = join(dir, "fake-codex-jsonl-last-message.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  writeFileSync(capturePath, JSON.stringify({ args, stdin }));
  const outputIndex = args.indexOf("--output-last-message");
  writeFileSync(args[outputIndex + 1], "last-message fallback answer");
  process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command", command: "npm test" } }) + "\\n");
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return commandPathForScript(scriptPath, "fake-codex-jsonl-last-message");
}

function fakeCodexWithoutJsonSupport(capturePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-jsonl-fallback-test-"));
  const scriptPath = join(dir, "fake-codex-jsonl-fallback.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
const args = process.argv.slice(2);
const attempts = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, "utf8")) : [];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  attempts.push({ args, stdin });
  writeFileSync(capturePath, JSON.stringify(attempts));
  if (args.includes("--json")) {
    process.stderr.write("unknown option --json");
    process.exit(2);
  }
  const outputIndex = args.indexOf("--output-last-message");
  writeFileSync(args[outputIndex + 1], "legacy fallback answer");
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return commandPathForScript(scriptPath, "fake-codex-jsonl-fallback");
}

/** Like fakeCodex, but also writes `progressText` to stdout before the final-message file. */
function fakeCodexWithStdoutProgress(progressText: string, response: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-progress-test-"));
  const scriptPath = join(dir, "fake-codex-progress.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.stdout.write(${JSON.stringify(progressText)});
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], ${JSON.stringify(response)});
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function fakeCodexThatNeverExits(commandName = "fake-codex-hang"): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-timeout-test-"));
  const scriptPath = join(dir, "fake-codex-hang.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.resume();
`,
  );
  chmodSync(scriptPath, 0o755);

  if (process.platform !== "win32") return scriptPath;

  const commandPath = join(dir, `${commandName}.cmd`);
  writeFileSync(commandPath, `@echo off\r\n"${argv0}" "${scriptPath}" %*\r\n`);
  return commandPath;
}

test("provider spawns codex and returns the last-message text", skipOnWindows, async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-cap-")), "cap.json");
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodex("direct spawn response", capturePath),
      modelLabel: "gpt-5-codex",
      timeoutMs: 10_000,
    },
  });

  const output = await provider.complete(input);

  assert.equal(output.text, "direct spawn response");
  assert.equal(output.metadata.provider, "codex-cli");
  assert.equal(output.metadata.model, "gpt-5-codex");
  const captured = readCapture(capturePath);
  assert.equal(captured.stdin, "Reply exactly once.");
  assert.equal(captured.args[0], "exec");
  assert.ok(captured.args.includes("--skip-git-repo-check"));
  assert.equal(captured.args.at(-1), "-");
  const modelIndex = captured.args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(captured.args[modelIndex + 1], "gpt-5-codex");
});

test("provider omits --model for blank, legacy, and mock labels", skipOnWindows, async () => {
  for (const label of [null, "", "gpt-5-codex-subscription", "mock-v1"]) {
    const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-cap-")), "cap.json");
    const provider = createCodexCliProvider({
      config: {
        commandPath: fakeCodex("default model response", capturePath),
        modelLabel: label,
        timeoutMs: 10_000,
      },
    });

    const output = await provider.complete(input);

    assert.equal(output.text, "default model response");
    assert.equal(output.metadata.model, label?.trim() ? label : "codex-default");
    assert.equal(readCapture(capturePath).args.includes("--model"), false, `label=${String(label)}`);
  }
});

test("provider forwards stdout chunks to onProgress while still using --output-last-message for the final text", skipOnWindows, async () => {
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodexWithStdoutProgress("reasoning: thinking about it...", "final answer"),
      modelLabel: "gpt-5-codex",
      timeoutMs: 10_000,
    },
  });
  const progressChunks: string[] = [];

  const output = await provider.complete({
    ...input,
    onProgress: (chunk) => {
      if (typeof chunk === "string") progressChunks.push(chunk);
    },
  });

  assert.equal(output.text, "final answer");
  assert.ok(progressChunks.join("").includes("reasoning: thinking about it..."));
});

test("provider succeeds without progress chunks when codex emits no useful stdout", skipOnWindows, async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-cap-")), "cap.json");
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodex("no stdout response", capturePath),
      modelLabel: "gpt-5-codex",
      timeoutMs: 10_000,
    },
  });
  const progressChunks: string[] = [];

  const output = await provider.complete({
    ...input,
    onProgress: (chunk) => {
      if (typeof chunk === "string") progressChunks.push(chunk);
    },
  });

  assert.equal(output.text, "no stdout response");
  assert.equal(progressChunks.length, 0);
});

test("provider prefers codex exec --json and emits structured observations before final response", async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-jsonl-cap-")), "cap.json");
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodexWithJsonl(capturePath),
      modelLabel: "gpt-5-codex",
      timeoutMs: 10_000,
    },
  });
  const observations: AgentObservation[] = [];

  const output = await provider.complete({
    ...input,
    onProgress: (progress) => {
      if (typeof progress !== "string") observations.push(progress);
    },
  });

  assert.equal(output.text, "json final answer");
  assert.ok(readCapture(capturePath).args.includes("--json"));
  assert.deepEqual(
    observations.map((observation) => observation.kind),
    ["command.started", "command.completed", "progress"],
  );
});

test("provider uses last-message output when JSONL has no final agent message", async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-jsonl-last-cap-")), "cap.json");
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodexWithJsonlAndLastMessageFallback(capturePath),
      modelLabel: "gpt-5-codex",
      timeoutMs: 10_000,
    },
  });
  const observations: AgentObservation[] = [];

  const output = await provider.complete({
    ...input,
    onProgress: (progress) => {
      if (typeof progress !== "string") observations.push(progress);
    },
  });

  assert.equal(output.text, "last-message fallback answer");
  assert.ok(readCapture(capturePath).args.includes("--json"));
  assert.deepEqual(observations.map((observation) => observation.kind), ["command.started"]);
});

test("provider falls back to legacy last-message mode when JSONL mode is unavailable", async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-jsonl-fallback-cap-")), "cap.json");
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodexWithoutJsonSupport(capturePath),
      modelLabel: "gpt-5-codex",
      timeoutMs: 10_000,
    },
  });
  const observations: AgentObservation[] = [];

  const output = await provider.complete({
    ...input,
    onProgress: (progress) => {
      if (typeof progress !== "string") observations.push(progress);
    },
  });

  const attempts = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{ args: string[] }>;
  assert.equal(output.text, "legacy fallback answer");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.args.includes("--json"), true);
  assert.equal(attempts[1]?.args.includes("--json"), false);
  assert.equal(observations[0]?.message, "Codex JSONL progress unavailable; using last-message fallback");
});

test("provider maps non-zero exit to a provider error", skipOnWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-fail-"));
  const scriptPath = join(dir, "failing-codex.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => { process.stderr.write("boom"); process.exit(3); });
`,
  );
  chmodSync(scriptPath, 0o755);
  const provider = createCodexCliProvider({
    config: { commandPath: scriptPath, modelLabel: null, timeoutMs: 10_000 },
  });

  await assert.rejects(() => provider.complete(input), /Codex CLI exited with code 3: boom/);
});

test("provider timeout error includes safe diagnostic context", async () => {
  const provider = createCodexCliProvider({
    config: {
      commandPath: fakeCodexThatNeverExits("fake-codex-hang-token-secret"),
      modelLabel: "gpt-5.5",
      timeoutMs: 5,
    },
  });

  await assert.rejects(
    () => provider.complete(input),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Codex CLI command timed out after 5ms/);
      assert.match(err.message, /model: gpt-5\.5/);
      assert.match(err.message, /command: fake-codex-hang-token-secret\.cmd|command: fake-codex-hang\.mjs/);
      assert.equal(err.message.includes(tmpdir()), false);
      return true;
    },
  );
});

test("provider rejects an empty command path", async () => {
  const provider = createCodexCliProvider({ config: { commandPath: "  ", modelLabel: null } });
  await assert.rejects(() => provider.complete(input), /Codex command path is required/);
});

test("provider rejects an empty codex response", skipOnWindows, async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-cap-")), "cap.json");
  const provider = createCodexCliProvider({
    config: { commandPath: fakeCodex("", capturePath), modelLabel: null, timeoutMs: 10_000 },
  });

  await assert.rejects(() => provider.complete(input), /Codex CLI returned an empty response/);
});
