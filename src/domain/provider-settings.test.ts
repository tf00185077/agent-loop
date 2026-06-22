import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProviderSettings,
  sanitizeStartGoalProviderOverride,
  sanitizeProviderStatus,
  type ProviderSettings,
  type StartGoalProviderOverride,
} from "./provider-settings.types.js";

test("defaults provider settings to mock with sanitized idle status", () => {
  assert.deepEqual(createDefaultProviderSettings(), {
    provider: "mock",
    modelLabel: "mock-v1",
    codexCommandPath: null,
    status: {
      state: "not_checked",
      detected: false,
      checkedAt: null,
      message: null,
    },
  } satisfies ProviderSettings);
});

test("sanitizes provider status messages before they are persisted or returned", () => {
  assert.deepEqual(
    sanitizeProviderStatus({
      state: "command_failure",
      detected: true,
      checkedAt: "2026-06-18T00:00:00.000Z",
      message:
        "failed with sk-test-secret Authorization: Bearer token and cookie=session; run codex exec --api-key abc",
    }),
    {
      state: "command_failure",
      detected: true,
      checkedAt: "2026-06-18T00:00:00.000Z",
      message:
        "failed with [redacted] Authorization: [redacted] and cookie=[redacted] run codex exec --api-key [redacted]",
    },
  );
});

test("defines provider-agnostic start goal provider override shapes", () => {
  const overrides = [
    {
      provider: "mock",
    },
    {
      provider: "codex-local",
      modelLabel: "gpt-5.4",
      codexCommandPath: "C:\\Program Files\\Codex\\codex.exe",
    },
    {
      provider: "claude-local",
      modelLabel: "claude-sonnet-4-6",
      claudeCommandPath: "/usr/local/bin/claude",
    },
  ] satisfies StartGoalProviderOverride[];

  assert.deepEqual(
    overrides.map((override) => override.provider),
    ["mock", "codex-local", "claude-local"],
  );
});

test("sanitizes start goal provider override command paths", () => {
  assert.deepEqual(
    sanitizeStartGoalProviderOverride({
      provider: "codex-local",
      modelLabel: "gpt5-4",
      codexCommandPath: "codex --api-key sk-secret --token abc --access-token xyz",
    }),
    {
      provider: "codex-local",
      modelLabel: "gpt5-4",
      codexCommandPath: "codex",
    },
  );

  assert.deepEqual(
    sanitizeStartGoalProviderOverride({
      provider: "claude-local",
      modelLabel: "claude-sonnet-4-6",
      claudeCommandPath: "claude --token abc",
    }),
    {
      provider: "claude-local",
      modelLabel: "claude-sonnet-4-6",
      claudeCommandPath: "claude",
    },
  );
});
