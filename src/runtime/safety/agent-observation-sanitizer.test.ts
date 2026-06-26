import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAgentObservation } from "./agent-observation-sanitizer.js";

test("redacts structured observation messages and command summaries", () => {
  const sanitized = sanitizeAgentObservation({
    kind: "command.failed",
    message: "Authorization: Bearer sk-commandsecret123456",
    command: {
      label: "codex exec --api-key live-secret-token",
      status: "failed",
      exitCode: 1,
      stdoutTail: "token=stdout-secret",
      stderrTail: "cookie: session-secret",
    },
    metadata: {
      provider: "codex-cli",
      model: "gpt-5-codex",
      source: "jsonl",
      rawEventType: "exec_command_failed",
    },
  });

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("sk-commandsecret123456"), false);
  assert.equal(serialized.includes("live-secret-token"), false);
  assert.equal(serialized.includes("stdout-secret"), false);
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(sanitized.message, "[redacted]");
  assert.equal(sanitized.command?.label, "codex exec [redacted]");
  assert.equal(sanitized.command?.stdoutTail, "[redacted]");
  assert.equal(sanitized.command?.stderrTail, "[redacted]");
});

test("drops raw JSONL payload fields while preserving allowlisted provenance", () => {
  const sanitized = sanitizeAgentObservation({
    kind: "progress",
    message: "working on it",
    metadata: {
      provider: "codex-cli",
      model: "gpt-5-codex",
      source: "jsonl",
      rawEventType: "thread.started",
    },
    rawPayload: {
      apiKey: "sk-rawpayloadsecret",
      command: "codex exec --token raw-secret",
    },
  });

  assert.deepEqual(sanitized, {
    kind: "progress",
    message: "working on it",
    metadata: {
      provider: "codex-cli",
      model: "gpt-5-codex",
      source: "jsonl",
      rawEventType: "thread.started",
    },
  });
});
