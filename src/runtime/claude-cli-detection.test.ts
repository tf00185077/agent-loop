import assert from "node:assert/strict";
import test from "node:test";

import { detectClaudeCliCommand } from "./claude-cli-detection.js";

test("detects claude on PATH", () => {
  const result = detectClaudeCliCommand({
    env: { PATH: "/opt/bin:/usr/local/bin", HOME: "/home/u" },
    platform: "linux",
    fileExists: (path) => path === "/usr/local/bin/claude",
    commandSupportsClaudePrint: () => true,
  });

  assert.equal(result.detected, true);
  assert.equal(result.source, "path");
  assert.equal(result.commandPath, "/usr/local/bin/claude");
});

test("falls back to ~/.local/bin/claude", () => {
  const result = detectClaudeCliCommand({
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    platform: "linux",
    fileExists: (path) => path === "/home/u/.local/bin/claude",
    commandSupportsClaudePrint: () => true,
  });

  assert.equal(result.source, "common");
  assert.equal(result.commandPath, "/home/u/.local/bin/claude");
});

test("reports not found when no claude exists", () => {
  const result = detectClaudeCliCommand({
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    platform: "linux",
    fileExists: () => false,
    commandSupportsClaudePrint: () => true,
  });

  assert.equal(result.detected, false);
  assert.equal(result.source, "none");
  assert.equal(result.status.state, "not_found");
  assert.match(result.status.message ?? "", /Claude CLI was not found/);
});

test("honors a valid saved manual path", () => {
  const result = detectClaudeCliCommand({
    manualPath: "/custom/claude",
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    platform: "linux",
    fileExists: (path) => path === "/custom/claude",
    commandSupportsClaudePrint: () => true,
  });

  assert.equal(result.source, "manual");
  assert.equal(result.commandPath, "/custom/claude");
});
