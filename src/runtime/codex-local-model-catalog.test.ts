import assert from "node:assert/strict";
import test from "node:test";

import { loadCodexModelCatalog } from "./codex-local-model-catalog.js";

const checkedAt = () => "2026-06-18T03:00:00.000Z";

test("parses selectable models and orders them by priority", async () => {
  const result = await loadCodexModelCatalog({
    codexCommandPath: "codex",
    source: "path",
    checkedAt,
    runCommand: async (request) => {
      assert.deepEqual(request.args, ["debug", "models"]);
      return JSON.stringify({
        models: [
          { slug: "gpt-5-codex", display_name: "GPT-5 Codex", description: "Latest", priority: 20 },
          { slug: "gpt-5-codex-mini", display_name: "GPT-5 Codex Mini", priority: 10 },
        ],
      });
    },
  });

  assert.equal(result.status.state, "available");
  assert.equal(result.source, "path");
  assert.deepEqual(
    result.models.map((m) => m.slug),
    ["gpt-5-codex-mini", "gpt-5-codex"],
  );
  assert.equal(result.defaultModelSlug, "gpt-5-codex-mini");
  assert.deepEqual(result.models[1], {
    slug: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    description: "Latest",
    priority: 20,
  });
});

test("filters hidden and non-listed models", async () => {
  const result = await loadCodexModelCatalog({
    codexCommandPath: "codex",
    checkedAt,
    runCommand: async () =>
      JSON.stringify({
        models: [
          { slug: "visible-model", priority: 1, visibility: "list" },
          { slug: "hidden-flag", priority: 2, hidden: true },
          { slug: "not-visible", priority: 3, visible: false },
          { slug: "internal-vis", priority: 4, visibility: "internal" },
        ],
      }),
  });

  assert.deepEqual(
    result.models.map((m) => m.slug),
    ["visible-model"],
  );
});

test("returns empty status when no selectable models remain", async () => {
  const result = await loadCodexModelCatalog({
    codexCommandPath: "codex",
    checkedAt,
    runCommand: async () => JSON.stringify({ models: [{ slug: "x", hidden: true }] }),
  });

  assert.equal(result.status.state, "empty");
  assert.deepEqual(result.models, []);
  assert.equal(result.defaultModelSlug, null);
});

test("returns unavailable status when output is malformed JSON", async () => {
  const result = await loadCodexModelCatalog({
    codexCommandPath: "codex",
    checkedAt,
    runCommand: async () => "not json at all",
  });

  assert.equal(result.status.state, "unavailable");
  assert.match(result.status.message ?? "", /malformed/i);
});

test("returns unavailable status when the command fails", async () => {
  const result = await loadCodexModelCatalog({
    codexCommandPath: "codex",
    checkedAt,
    runCommand: async () => {
      throw new Error("Codex CLI model catalog command exited with code 1");
    },
  });

  assert.equal(result.status.state, "unavailable");
  assert.deepEqual(result.models, []);
  assert.equal(result.defaultModelSlug, null);
});

test("omits raw metadata, prompts, and credential fields from mapped models", async () => {
  const result = await loadCodexModelCatalog({
    codexCommandPath: "codex",
    checkedAt,
    runCommand: async () =>
      JSON.stringify({
        models: [
          {
            slug: "gpt-5-codex",
            display_name: "GPT-5 Codex",
            priority: 1,
            base_instructions: "SYSTEM PROMPT internal text",
            prompt: "hidden prompt metadata",
            upgrade: { plan: "pro" },
            access_token: "sk-secret-token",
            cookie: "session=abc",
          },
        ],
      }),
  });

  const serialized = JSON.stringify(result.models);
  assert.equal(serialized.includes("base_instructions"), false);
  assert.equal(serialized.includes("SYSTEM PROMPT"), false);
  assert.equal(serialized.includes("hidden prompt metadata"), false);
  assert.equal(serialized.includes("sk-secret-token"), false);
  assert.equal(serialized.includes("session=abc"), false);
  assert.deepEqual(Object.keys(result.models[0]).sort(), [
    "description",
    "displayName",
    "priority",
    "slug",
  ]);
});
