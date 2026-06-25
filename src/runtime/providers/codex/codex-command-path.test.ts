import assert from "node:assert/strict";
import test from "node:test";

import type { CodexCliDetectionResult } from "./codex-cli-detection.js";
import { resolveCodexCommandPath } from "./codex-command-path.js";

function detected(commandPath: string, source: "manual" | "path" | "common"): CodexCliDetectionResult {
  return {
    detected: true,
    commandPath,
    source,
    status: { state: "detected", detected: true, checkedAt: null, message: "ok" },
  };
}

const notFound: CodexCliDetectionResult = {
  detected: false,
  commandPath: null,
  source: "none",
  status: {
    state: "not_found",
    detected: false,
    checkedAt: null,
    message: "Codex CLI was not found.",
  },
};

test("valid saved path is reused without persisting", () => {
  const persisted: string[] = [];
  const result = resolveCodexCommandPath({
    savedPath: "/saved/codex",
    detect: () => detected("/saved/codex", "manual"),
    persist: (path) => persisted.push(path),
  });

  assert.equal(result.commandPath, "/saved/codex");
  assert.equal(result.changed, false);
  assert.deepEqual(persisted, []);
});

test("stale saved path triggers re-detect and persist of the new path", () => {
  const persisted: string[] = [];
  const result = resolveCodexCommandPath({
    savedPath: "/old/codex",
    detect: () => detected("/usr/local/bin/codex", "path"),
    persist: (path) => persisted.push(path),
  });

  assert.equal(result.commandPath, "/usr/local/bin/codex");
  assert.equal(result.changed, true);
  assert.equal(result.source, "path");
  assert.deepEqual(persisted, ["/usr/local/bin/codex"]);
});

test("detection from no saved path persists the first discovery", () => {
  const persisted: string[] = [];
  const result = resolveCodexCommandPath({
    savedPath: null,
    detect: () => detected("/opt/homebrew/bin/codex", "common"),
    persist: (path) => persisted.push(path),
  });

  assert.equal(result.commandPath, "/opt/homebrew/bin/codex");
  assert.equal(result.changed, true);
  assert.deepEqual(persisted, ["/opt/homebrew/bin/codex"]);
});

test("no resolvable path surfaces not-found and does not persist", () => {
  const persisted: string[] = [];
  const result = resolveCodexCommandPath({
    savedPath: "/old/codex",
    detect: () => notFound,
    persist: (path) => persisted.push(path),
  });

  assert.equal(result.commandPath, null);
  assert.equal(result.changed, false);
  assert.equal(result.status.state, "not_found");
  assert.deepEqual(persisted, []);
});
