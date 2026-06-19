import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("wrapper uses Codex CLI default model for legacy subscription label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-wrapper-"));
  const capturePath = join(dir, "captured.json");
  const fakeCodexPath = join(dir, "fake-codex.mjs");

  writeFileSync(
    fakeCodexPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.env.CAPTURE_PATH;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], "fake wrapper response");
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`.trimStart(),
  );

  const result = await runWrapper({
    codexCommandPath: process.execPath,
    extraArgs: [fakeCodexPath],
    modelLabel: "gpt-5-codex-subscription",
    capturePath,
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { text: "fake wrapper response" });

  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
    args: string[];
    stdin: string;
  };
  assert.equal(captured.args.includes("--model"), false);
  assert.equal(captured.stdin, "Reply exactly once.");
});

test("wrapper uses Codex CLI default model for mock model label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-wrapper-"));
  const capturePath = join(dir, "captured-mock-model.json");
  const fakeCodexPath = join(dir, "fake-codex.mjs");

  writeFileSync(
    fakeCodexPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.env.CAPTURE_PATH;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], "mock label response");
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`.trimStart(),
  );

  const result = await runWrapper({
    codexCommandPath: process.execPath,
    extraArgs: [fakeCodexPath],
    modelLabel: "mock-v1",
    capturePath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { text: "mock label response" });

  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
    args: string[];
    stdin: string;
  };
  assert.equal(captured.args.includes("--model"), false);
});

test("wrapper passes a selected catalog model slug as --model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-wrapper-"));
  const capturePath = join(dir, "captured-selected-model.json");
  const fakeCodexPath = join(dir, "fake-codex.mjs");

  writeFileSync(
    fakeCodexPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.env.CAPTURE_PATH;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], "selected model response");
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`.trimStart(),
  );

  const result = await runWrapper({
    codexCommandPath: process.execPath,
    extraArgs: [fakeCodexPath],
    modelLabel: "gpt-5-codex",
    capturePath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { text: "selected model response" });

  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
    args: string[];
    stdin: string;
  };
  const modelIndex = captured.args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(captured.args[modelIndex + 1], "gpt-5-codex");
});

test("wrapper uses Codex CLI default model when the model label is blank", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-wrapper-"));
  const capturePath = join(dir, "captured-blank-model.json");
  const fakeCodexPath = join(dir, "fake-codex.mjs");

  writeFileSync(
    fakeCodexPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.env.CAPTURE_PATH;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], "blank label response");
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`.trimStart(),
  );

  const result = await runWrapper({
    codexCommandPath: process.execPath,
    extraArgs: [fakeCodexPath],
    modelLabel: "",
    capturePath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { text: "blank label response" });

  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
    args: string[];
    stdin: string;
  };
  assert.equal(captured.args.includes("--model"), false);
});

test("wrapper can invoke a Windows cmd shim Codex command", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-wrapper-"));
  const capturePath = join(dir, "captured-cmd.json");
  const fakeCodexPath = join(dir, "fake-codex.mjs");
  const fakeCmdPath = join(dir, "codex.cmd");

  writeFileSync(
    fakeCodexPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.env.CAPTURE_PATH;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], "cmd shim response");
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`.trimStart(),
  );
  writeFileSync(
    fakeCmdPath,
    `@echo off\r\n"${process.execPath}" "${fakeCodexPath}" %*\r\n`,
  );

  const result = await runWrapper({
    codexCommandPath: fakeCmdPath,
    extraArgs: [],
    modelLabel: "gpt-5-codex-subscription",
    capturePath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { text: "cmd shim response" });
  assert.equal(JSON.parse(readFileSync(capturePath, "utf8")).stdin, "Reply exactly once.");
});

function runWrapper(options: {
  codexCommandPath: string;
  extraArgs: string[];
  modelLabel: string;
  capturePath: string;
}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("scripts", "codex-local-agent-wrapper.mjs")], {
      env: {
        ...process.env,
        AUTO_AGENT_CODEX_COMMAND_PATH: options.codexCommandPath,
        AUTO_AGENT_CODEX_COMMAND_ARGS_JSON: JSON.stringify(options.extraArgs),
        AUTO_AGENT_OPENAI_LOCAL_MODEL: options.modelLabel,
        CAPTURE_PATH: options.capturePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(
      `${JSON.stringify({
        goal: { id: "goal-1", title: "Wrapper test", description: "Exercise wrapper" },
        prompt: "Reply exactly once.",
      })}\n`,
    );
  });
}
