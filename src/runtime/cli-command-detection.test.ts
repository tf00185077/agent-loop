import assert from "node:assert/strict";
import test from "node:test";

import { detectCliCommand, type CliCommandDetectionConfig } from "./cli-command-detection.js";

const config: CliCommandDetectionConfig = {
  commandNames: (platform) => (platform === "win32" ? ["tool.cmd", "tool.exe"] : ["tool"]),
  commandSupports: () => true,
  commonPaths: (ctx) => (ctx.env.HOME ? [`${ctx.env.HOME}/.local/bin/tool`] : []),
  messages: { notFound: "not found", manual: "manual", path: "on path", common: "common" },
};

test("manual path wins when it exists and passes the probe", () => {
  const result = detectCliCommand(config, {
    manualPath: "/manual/tool",
    platform: "linux",
    env: { PATH: "/usr/bin" },
    fileExists: (p) => p === "/manual/tool",
  });
  assert.equal(result.detected, true);
  assert.equal(result.source, "manual");
  assert.equal(result.commandPath, "/manual/tool");
});

test("detection prefers a command on PATH", () => {
  const result = detectCliCommand(config, {
    platform: "linux",
    env: { PATH: "/opt/bin:/usr/bin", HOME: "/home/u" },
    fileExists: (p) => p === "/usr/bin/tool",
  });
  assert.equal(result.source, "path");
  assert.equal(result.commandPath, "/usr/bin/tool");
});

test("detection falls back to a common install location", () => {
  const result = detectCliCommand(config, {
    platform: "linux",
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    fileExists: (p) => p === "/home/u/.local/bin/tool",
  });
  assert.equal(result.source, "common");
  assert.equal(result.commandPath, "/home/u/.local/bin/tool");
});

test("capability probe can reject a found file", () => {
  const result = detectCliCommand(config, {
    platform: "linux",
    env: { PATH: "/usr/bin" },
    fileExists: () => true,
    commandSupports: () => false,
  });
  assert.equal(result.detected, false);
  assert.equal(result.source, "none");
  assert.equal(result.status.state, "not_found");
  assert.equal(result.status.message, "not found");
});

test("quoted candidates are normalized", () => {
  const result = detectCliCommand(config, {
    manualPath: '  "/manual/tool"  ',
    platform: "linux",
    env: {},
    fileExists: (p) => p === "/manual/tool",
  });
  assert.equal(result.commandPath, "/manual/tool");
});
