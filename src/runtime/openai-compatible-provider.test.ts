import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAICompatibleProvider } from "./openai-compatible-provider.js";

test("provider exposes display metadata before execution without credentials", () => {
  const provider = createOpenAICompatibleProvider({
    config: {
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-secret",
      model: "gpt-test",
    },
  });

  assert.deepEqual(provider.metadata, { provider: "openai-compatible", model: "gpt-test" });
  const serializedMetadata = JSON.stringify(provider.metadata);
  assert.equal(serializedMetadata.includes("apiKey"), false);
  assert.equal(serializedMetadata.includes("sk-secret"), false);
  assert.equal(serializedMetadata.includes("Authorization"), false);
});
