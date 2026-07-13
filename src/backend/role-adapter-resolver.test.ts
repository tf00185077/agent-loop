import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeAdapter, ProviderSettings } from "../domain/index.js";
import { createRoleAdapterResolver } from "./role-adapter-resolver.js";

function settingsWith(roleAssignments: ProviderSettings["roleAssignments"]): ProviderSettings {
  return {
    provider: "codex-local",
    modelLabel: "gpt-5.5",
    codexCommandPath: "C:\\Tools\\codex.exe",
    status: { state: "detected", detected: true, checkedAt: null, message: null },
    ...(roleAssignments ? { roleAssignments } : {}),
  };
}

function fakeAdapter(providerId: string): AgentRuntimeAdapter {
  return {
    providerId,
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession() {
      throw new Error("not used");
    },
  };
}

test("returns null for roles without an assignment", () => {
  const resolver = createRoleAdapterResolver({ getSettings: () => settingsWith(undefined) });

  assert.equal(resolver("worker"), null);
  assert.equal(resolver("review_merge"), null);
});

test("injected adapters take precedence over construction", () => {
  const injected = fakeAdapter("claude-local");
  const resolver = createRoleAdapterResolver({
    getSettings: () =>
      settingsWith({
        worker: { provider: "claude-local", modelLabel: " claude-sonnet-4 ", commandPath: null },
      }),
    agentRuntimeAdapters: { "claude-local": injected },
  });

  const resolved = resolver("worker");
  assert.equal(resolved?.adapter, injected);
  assert.equal(resolved?.providerId, "claude-local");
  assert.equal(resolved?.modelLabel, "claude-sonnet-4");
});

test("blank model labels resolve to null (provider default)", () => {
  const resolver = createRoleAdapterResolver({
    getSettings: () =>
      settingsWith({ review_merge: { provider: "mock", modelLabel: "  ", commandPath: null } }),
  });

  const resolved = resolver("review_merge");
  assert.equal(resolved?.providerId, "mock");
  assert.equal(resolved?.modelLabel, null);
});

test("constructs codex and claude adapters from assignment paths with detection stubs", async () => {
  const resolver = createRoleAdapterResolver({
    getSettings: () =>
      settingsWith({
        worker: { provider: "claude-local", modelLabel: "claude-sonnet-4", commandPath: "C:\\Tools\\claude.cmd" },
        spec_writer: { provider: "codex-local", modelLabel: "gpt-5.5", commandPath: "C:\\Tools\\codex.exe" },
      }),
    detectCodexCliCommand: () => ({
      detected: true,
      commandPath: "C:\\Tools\\codex.exe",
      source: "manual",
      status: { state: "detected", detected: true, checkedAt: null, message: null },
    }),
    detectClaudeCliCommand: () => ({
      detected: true,
      commandPath: "C:\\Tools\\claude.cmd",
      source: "manual",
      status: { state: "detected", detected: true, checkedAt: null, message: null },
    }),
    codexRuntimeCapabilityProbe: async () => ({ execJson: true, approvalResume: false }),
    claudeRuntimeCapabilityProbe: async () => ({ printMode: true }),
  });

  const worker = resolver("worker");
  const specWriter = resolver("spec_writer");

  assert.equal(worker?.adapter.providerId, "claude-local");
  assert.equal((await worker!.adapter.detectCapabilities()).eventStreaming, true);
  assert.equal(specWriter?.adapter.providerId, "codex-local");
  assert.equal((await specWriter!.adapter.detectCapabilities()).eventStreaming, true);
});
