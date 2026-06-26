import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexRuntimeAdapter,
  detectCodexRuntimeCapabilities,
  type CodexRuntimeCapabilityProbeResult,
} from "./codex-runtime-adapter.js";

test("detects Codex JSONL runtime capabilities with approval explicitly unsupported", async () => {
  const capabilities = await detectCodexRuntimeCapabilities({
    commandPath: "C:\\Tools\\codex.exe",
    probe: async () => ({
      execJson: true,
      approvalResume: false,
    }),
  });

  assert.equal(capabilities.eventStreaming, true);
  assert.equal(capabilities.approval, false);
  assert.equal(capabilities.cancellation, true);
  assert.equal(capabilities.resume, false);
  assert.equal(capabilities.childSessions, false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /approval resume/i);
});

test("detects approval-supported Codex mode only when the probe verifies resume support", async () => {
  const adapter = createCodexRuntimeAdapter({
    commandPath: "C:\\Tools\\codex.exe",
    modelLabel: "gpt-5-codex",
    probe: async () => ({
      execJson: true,
      approvalResume: true,
    }),
  });

  assert.deepEqual(await adapter.detectCapabilities(), {
    eventStreaming: true,
    approval: true,
    cancellation: true,
    resume: true,
    childSessions: false,
    unsupportedReasons: {
      child_sessions: "Child-session scheduling is not enabled for Codex runtime sessions.",
    },
  });
});

test("marks cancellation unavailable when Codex JSONL session mode is unavailable", async () => {
  const capabilities = await detectCodexRuntimeCapabilities({
    commandPath: "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
    probe: async () => ({
      execJson: false,
      approvalResume: false,
      reason: "codex exec --json is not supported by this CLI.",
    }),
  });

  assert.equal(capabilities.eventStreaming, false);
  assert.equal(capabilities.cancellation, false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /not supported/i);
  assert.match(capabilities.unsupportedReasons?.cancellation ?? "", /requires JSONL/i);
});

test("reports sanitized startup failure capabilities without command secrets", async () => {
  const capabilities = await detectCodexRuntimeCapabilities({
    commandPath: "C:\\Tools\\codex.cmd --api-key sk-secret --token hidden",
    probe: async (): Promise<CodexRuntimeCapabilityProbeResult> => {
      throw new Error("spawn C:\\Tools\\codex.cmd --api-key sk-secret --token hidden ENOENT");
    },
  });

  const serialized = JSON.stringify(capabilities);
  assert.equal(capabilities.eventStreaming, false);
  assert.equal(capabilities.approval, false);
  assert.equal(capabilities.cancellation, false);
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("hidden"), false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /failed to start/i);
});
