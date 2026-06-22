import assert from "node:assert/strict";
import test from "node:test";

import { resolveQuorumVoters } from "./quorum-voters.js";

test("resolveQuorumVoters prefers three distinct configured providers", () => {
  assert.deepEqual(
    resolveQuorumVoters({
      availableProviders: ["claude-local", "codex-local", "openai-compatible"],
      fallbackProvider: "codex-local",
    }),
    [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "claude-local", providerKind: "claude-local" },
      { voterId: "openai-compatible", providerKind: "openai-compatible" },
    ],
  );
});

test("resolveQuorumVoters fills missing providers with persona fallbacks", () => {
  assert.deepEqual(
    resolveQuorumVoters({
      availableProviders: ["codex-local"],
      fallbackProvider: "codex-local",
    }),
    [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "codex-local-skeptic", providerKind: "codex-local", persona: "skeptic" },
      { voterId: "codex-local-optimist", providerKind: "codex-local", persona: "optimist" },
    ],
  );
});

test("resolveQuorumVoters deduplicates providers and preserves priority order", () => {
  assert.deepEqual(
    resolveQuorumVoters({
      availableProviders: ["openai-compatible", "codex-local", "codex-local"],
      fallbackProvider: "openai-compatible",
    }),
    [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "openai-compatible", providerKind: "openai-compatible" },
      {
        voterId: "openai-compatible-skeptic",
        providerKind: "openai-compatible",
        persona: "skeptic",
      },
    ],
  );
});
