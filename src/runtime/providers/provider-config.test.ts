import assert from "node:assert/strict";
import test from "node:test";

import {
  loadProviderConfig,
  ProviderConfigError,
  type ProviderEnvironment,
} from "./provider-config.js";

test("defaults to mock provider config", () => {
  assert.deepEqual(loadProviderConfig({}), {
    provider: "mock",
    model: "mock-v1",
  });
});

test("loads OpenAI-compatible provider config from environment", () => {
  const env: ProviderEnvironment = {
    AUTO_AGENT_PROVIDER: " openai-compatible ",
    AUTO_AGENT_BASE_URL: " https://example.test/v1 ",
    AUTO_AGENT_API_KEY: " test-key ",
    AUTO_AGENT_MODEL: " test-model ",
  };

  assert.deepEqual(loadProviderConfig(env), {
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "test-model",
  });
});

test("rejects the removed openai-local-agent provider", () => {
  assert.throws(
    () => loadProviderConfig({ AUTO_AGENT_PROVIDER: "openai-local-agent" }),
    /Unsupported AUTO_AGENT_PROVIDER: openai-local-agent/,
  );
});

test("preserves missing OpenAI-compatible values for runtime failure handling", () => {
  assert.deepEqual(loadProviderConfig({ AUTO_AGENT_PROVIDER: "openai-compatible" }), {
    provider: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
  });
});

test("rejects unsupported provider names", () => {
  assert.throws(
    () => loadProviderConfig({ AUTO_AGENT_PROVIDER: "unknown-provider" }),
    ProviderConfigError,
  );
});
