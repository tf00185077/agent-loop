import assert from "node:assert/strict";
import test from "node:test";

import type { CliCommandDetectionResult } from "./cli-command-detection.js";
import { resolveCliCommandPath } from "./cli-command-path.js";

function detected(commandPath: string, source: "manual" | "path" | "common"): CliCommandDetectionResult {
  return {
    detected: true,
    commandPath,
    source,
    status: { state: "detected", detected: true, checkedAt: null, message: "ok" },
  };
}

const notFound: CliCommandDetectionResult = {
  detected: false,
  commandPath: null,
  source: "none",
  status: { state: "not_found", detected: false, checkedAt: null, message: "not found" },
};

test("valid saved path is reused without persisting", () => {
  const persisted: string[] = [];
  const result = resolveCliCommandPath({
    savedPath: "/saved/tool",
    detect: (manualPath) => {
      assert.equal(manualPath, "/saved/tool");
      return detected("/saved/tool", "manual");
    },
    persist: (p) => persisted.push(p),
  });
  assert.equal(result.commandPath, "/saved/tool");
  assert.equal(result.changed, false);
  assert.deepEqual(persisted, []);
});

test("stale saved path is re-detected and persisted", () => {
  const persisted: string[] = [];
  const result = resolveCliCommandPath({
    savedPath: "/old/tool",
    detect: () => detected("/usr/local/bin/tool", "path"),
    persist: (p) => persisted.push(p),
  });
  assert.equal(result.commandPath, "/usr/local/bin/tool");
  assert.equal(result.changed, true);
  assert.equal(result.source, "path");
  assert.deepEqual(persisted, ["/usr/local/bin/tool"]);
});

test("nothing resolves yields not-found and does not persist", () => {
  const persisted: string[] = [];
  const result = resolveCliCommandPath({
    savedPath: "/old/tool",
    detect: () => notFound,
    persist: (p) => persisted.push(p),
  });
  assert.equal(result.commandPath, null);
  assert.equal(result.changed, false);
  assert.equal(result.status.state, "not_found");
  assert.deepEqual(persisted, []);
});
