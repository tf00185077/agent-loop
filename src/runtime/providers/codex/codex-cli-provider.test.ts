import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv0 } from "node:process";
import test from "node:test";

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

  const output = await provider.complete({ ...input, onProgress: (chunk) => progressChunks.push(chunk) });

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

  const output = await provider.complete({ ...input, onProgress: (chunk) => progressChunks.push(chunk) });

  assert.equal(output.text, "no stdout response");
  assert.equal(progressChunks.length, 0);
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
