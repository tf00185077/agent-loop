import assert from "node:assert/strict";
import test from "node:test";

import { detectCodexCliCommand } from "./codex-cli-detection.js";

test("detects Codex CLI using manual path, PATH, then common local install locations", () => {
  const existingPaths = new Set([
    "C:\\Users\\TIM\\manual\\codex.exe",
    "C:\\Tools\\codex.cmd",
    "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
  ]);

  assert.deepEqual(
    detectCodexCliCommand({
      manualPath: " C:\\Users\\TIM\\manual\\codex.exe ",
      env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
      platform: "win32",
      fileExists: (path) => existingPaths.has(path),
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

  assert.equal(
    detectCodexCliCommand({
      manualPath: "C:\\missing\\codex.exe",
      env: { PATH: "C:\\Tools", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
      platform: "win32",
      fileExists: (path) => existingPaths.has(path),
    }).source,
    "path",
  );

  assert.equal(
    detectCodexCliCommand({
      env: { PATH: "C:\\Missing", APPDATA: "C:\\Users\\TIM\\AppData\\Roaming" },
      platform: "win32",
      fileExists: (path) => existingPaths.has(path),
    }).source,
    "common",
  );
});
