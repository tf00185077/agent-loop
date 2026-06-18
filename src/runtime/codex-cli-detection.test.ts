import assert from "node:assert/strict";
import test from "node:test";

import { detectCodexCliCommand } from "./codex-cli-detection.js";

test("manual path overrides PATH detection when it exists", () => {
  const existingPaths = new Set([
    "C:\\Users\\TIM\\manual\\codex.exe",
    "C:\\Tools\\codex.cmd",
  ]);

  assert.deepEqual(
    detectCodexCliCommand({
      manualPath: " C:\\Users\\TIM\\manual\\codex.exe ",
      env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
      platform: "win32",
      fileExists: (path) => existingPaths.has(path),
      commandSupportsCodexExec: () => true,
    }),
    {
      detected: true,
      commandPath: "C:\\Users\\TIM\\manual\\codex.exe",
      source: "manual",
      status: {
        state: "detected",
        detected: true,
        checkedAt: null,
        message: "Codex CLI detected from saved manual path.",
      },
    },
  );
});

test("detects Codex CLI from PATH without requiring real Codex network access", () => {
  const result = detectCodexCliCommand({
    manualPath: "C:\\missing\\codex.exe",
    env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
    platform: "win32",
    fileExists: (path) => path === "C:\\Tools\\codex.cmd",
    commandSupportsCodexExec: () => true,
  });

  assert.equal(result.source, "path");
  assert.equal(result.commandPath, "C:\\Tools\\codex.cmd");
  assert.equal(result.status.state, "detected");
});

test("skips unsupported saved command and uses supported PATH command", () => {
  const result = detectCodexCliCommand({
    manualPath: "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
    env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
    platform: "win32",
    fileExists: (path) =>
      path === "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd" ||
      path === "C:\\Tools\\codex.exe",
    commandSupportsCodexExec: (path) => path.endsWith("codex.exe"),
  });

  assert.equal(result.source, "path");
  assert.equal(result.commandPath, "C:\\Tools\\codex.exe");
  assert.equal(result.status.state, "detected");
});

test("detects Codex CLI from a common local install location after PATH misses", () => {
  const result = detectCodexCliCommand({
    env: { PATH: "C:\\Missing", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
    platform: "win32",
    fileExists: (path) => path === "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
    commandSupportsCodexExec: () => true,
  });

  assert.equal(result.source, "common");
  assert.equal(result.commandPath, "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd");
  assert.equal(result.status.state, "detected");
});

test("reports not found when no manual, PATH, or common Codex CLI candidate exists", () => {
  assert.deepEqual(
    detectCodexCliCommand({
      manualPath: "C:\\missing\\codex.exe",
      env: { PATH: "C:\\Missing", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
      platform: "win32",
      fileExists: () => false,
    }),
    {
      detected: false,
      commandPath: null,
      source: "none",
      status: {
        state: "not_found",
        detected: false,
        checkedAt: null,
        message: "Codex CLI was not found. Install Codex CLI or enter a manual command path.",
      },
    },
  );
});
