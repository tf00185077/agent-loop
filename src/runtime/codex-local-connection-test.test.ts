import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { testCodexLocalConnection } from "./codex-local-connection-test.js";

test("default Codex local wrapper script exists", () => {
  assert.equal(existsSync(resolve("scripts", "codex-local-agent-wrapper.mjs")), true);
});

test("returns connected status when the Codex local wrapper returns text", async () => {
  const result = await testCodexLocalConnection({
    codexCommandPath: "C:\\Tools\\codex.cmd",
    modelLabel: "gpt-5-codex-subscription",
    checkedAt: () => "2026-06-18T03:00:00.000Z",
    runCommand: async (request) => {
      assert.equal(request.env.AUTO_AGENT_CODEX_COMMAND_PATH, "C:\\Tools\\codex.cmd");
      assert.equal(request.input.prompt, "Reply with exactly: codex-local-connection-ok");
      return JSON.stringify({ text: "codex-local-connection-ok" });
    },
  });

  assert.deepEqual(result.status, {
    state: "connected",
    detected: true,
    checkedAt: "2026-06-18T03:00:00.000Z",
    message: "Codex Local connection test succeeded.",
  });
});

test("classifies command-not-found connection failures", async () => {
  const result = await testCodexLocalConnection({
    codexCommandPath: "C:\\missing\\codex.cmd",
    modelLabel: "gpt-5-codex-subscription",
    checkedAt: () => "2026-06-18T03:00:00.000Z",
    runCommand: async () => {
      const error = new Error("spawn C:\\missing\\codex.cmd ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(result.status.state, "not_found");
  assert.equal(result.status.detected, false);
});

test("classifies authentication-needed or unusable-auth connection failures", async () => {
  const result = await testCodexLocalConnection({
    codexCommandPath: "codex",
    modelLabel: "gpt-5-codex-subscription",
    checkedAt: () => "2026-06-18T03:00:00.000Z",
    runCommand: async () => {
      throw new Error("Codex authentication required. Run codex login.");
    },
  });

  assert.equal(result.status.state, "login_required");
  assert.match(result.status.message ?? "", /codex login/);
});

test("classifies network failures", async () => {
  const result = await testCodexLocalConnection({
    codexCommandPath: "codex",
    modelLabel: "gpt-5-codex-subscription",
    checkedAt: () => "2026-06-18T03:00:00.000Z",
    runCommand: async () => {
      throw new Error("request failed: ECONNRESET network unavailable");
    },
  });

  assert.equal(result.status.state, "network_failure");
});

test("classifies generic command failures and sanitizes secret-bearing output", async () => {
  const result = await testCodexLocalConnection({
    codexCommandPath: "codex",
    modelLabel: "gpt-5-codex-subscription",
    checkedAt: () => "2026-06-18T03:00:00.000Z",
    runCommand: async () => {
      throw new Error("wrapper failed with sk-test-secret Authorization: Bearer token");
    },
  });

  assert.equal(result.status.state, "command_failure");
  assert.equal(result.status.message?.includes("sk-test-secret"), false);
  assert.equal(result.status.message?.includes("Bearer token"), false);
});
