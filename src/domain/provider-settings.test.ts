import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProviderSettings,
  sanitizeProviderStatus,
  type ProviderSettings,
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
