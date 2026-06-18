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

test("loads openai-local-agent provider config from environment", () => {
  const env: ProviderEnvironment = {
    AUTO_AGENT_PROVIDER: " openai-local-agent ",
    AUTO_AGENT_OPENAI_LOCAL_COMMAND: " codex ",
    AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON: '["exec","--json"]',
    AUTO_AGENT_OPENAI_LOCAL_MODEL: " gpt-5-codex-subscription ",
    AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS: "45000",
  };

  assert.deepEqual(loadProviderConfig(env), {
    provider: "openai-local-agent",
    command: "codex",
    args: ["exec", "--json"],
    model: "gpt-5-codex-subscription",
    timeoutMs: 45_000,
  });
});

test("preserves missing openai-local-agent command for runtime failure handling", () => {
  assert.deepEqual(loadProviderConfig({ AUTO_AGENT_PROVIDER: "openai-local-agent" }), {
    provider: "openai-local-agent",
    command: "",
    args: [],
    model: "openai-subscription-local-agent",
    timeoutMs: 120_000,
  });
});

test("rejects invalid openai-local-agent args JSON", () => {
  assert.throws(
    () =>
      loadProviderConfig({
        AUTO_AGENT_PROVIDER: "openai-local-agent",
        AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON: "--json",
      }),
    /AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON must be a JSON array of strings/,
  );
});

test("rejects invalid openai-local-agent timeout", () => {
  assert.throws(
    () =>
      loadProviderConfig({
        AUTO_AGENT_PROVIDER: "openai-local-agent",
        AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS: "0",
      }),
    /AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS must be a positive integer/,
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
