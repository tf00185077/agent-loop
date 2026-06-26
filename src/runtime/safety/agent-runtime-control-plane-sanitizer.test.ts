import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentRuntimeApprovalRequest,
  AgentRuntimeChildSessionRequest,
  AgentRuntimeCommandRecord,
} from "../../domain/index.js";
import {
  sanitizeAgentRuntimeApprovalRequest,
  sanitizeAgentRuntimeChildSessionRequest,
  sanitizeAgentRuntimeCommandRecord,
} from "./agent-runtime-control-plane-sanitizer.js";

test("redacts approval summaries and nested command metadata", () => {
  const approval: AgentRuntimeApprovalRequest = {
    id: "approval-1",
    sessionId: "session-1",
    commandId: "command-1",
    status: "pending",
    safeSummary: "Run curl with Authorization: Bearer secret-token",
    command: {
      id: "command-1",
      sessionId: "session-1",
      status: "pending",
      safeCommand: "curl https://example.test --api-key live-secret",
      cwd: "C:\\Users\\TIM\\.codex\\auth.json",
      startedAt: null,
      completedAt: null,
      exitCode: null,
      diagnostics: {
        summary: "cookie: local-session",
      },
    },
    createdAt: "2026-06-26T00:00:00.000Z",
    resolvedAt: null,
    resolutionReason: null,
  };

  const sanitized = sanitizeAgentRuntimeApprovalRequest(approval);
  const serialized = JSON.stringify(sanitized);

  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("live-secret"), false);
  assert.equal(serialized.includes("local-session"), false);
  assert.equal(serialized.includes("auth.json"), false);
  assert.equal(sanitized.safeSummary, "Run curl with [redacted]");
  assert.equal(sanitized.command?.safeCommand, "curl https://example.test [redacted]");
  assert.equal(sanitized.command?.cwd, "[redacted-auth-cache-path]");
  assert.equal(sanitized.command?.diagnostics?.summary, "[redacted]");
});

test("redacts command diagnostics while preserving non-secret execution metadata", () => {
  const command: AgentRuntimeCommandRecord = {
    id: "command-1",
    sessionId: "session-1",
    status: "failed",
    safeCommand: "npm.ps1 test --token command-secret",
    cwd: "C:\\Users\\TIM\\Desktop\\self\\auto-agent",
    startedAt: "2026-06-26T00:00:01.000Z",
    completedAt: "2026-06-26T00:00:02.000Z",
    exitCode: 1,
    diagnostics: {
      summary: "PowerShell blocked npm.ps1; retry with npm.cmd. ACCESS_TOKEN=secret",
      platform: "win32",
      reason: "PSSecurityException",
    },
  };

  const sanitized = sanitizeAgentRuntimeCommandRecord(command);

  assert.equal(JSON.stringify(sanitized).includes("command-secret"), false);
  assert.equal(JSON.stringify(sanitized).includes("ACCESS_TOKEN=secret"), false);
  assert.equal(sanitized.safeCommand, "npm.ps1 test [redacted]");
  assert.equal(sanitized.cwd, "C:\\Users\\TIM\\Desktop\\self\\auto-agent");
  assert.equal(
    sanitized.diagnostics?.summary,
    "PowerShell blocked npm.ps1; retry with npm.cmd. [redacted]",
  );
  assert.equal(sanitized.diagnostics?.platform, "win32");
  assert.equal(sanitized.diagnostics?.reason, "PSSecurityException");
});

test("redacts child-session prompt summaries and safe reasons", () => {
  const request: AgentRuntimeChildSessionRequest = {
    id: "child-request-1",
    parentSessionId: "session-1",
    parentAgentId: "agent-main",
    childRole: "reviewer",
    taskId: "task-4",
    promptSummary: "Review code using OPENAI_API_KEY=child-secret",
    status: "unsupported",
    createdAt: "2026-06-26T00:00:03.000Z",
    resolvedAt: "2026-06-26T00:00:04.000Z",
    safeReason: "Child scheduling blocked for cookie: session-secret",
  };

  const sanitized = sanitizeAgentRuntimeChildSessionRequest(request);
  const serialized = JSON.stringify(sanitized);

  assert.equal(serialized.includes("child-secret"), false);
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(sanitized.promptSummary, "Review code using [redacted]");
  assert.equal(sanitized.safeReason, "Child scheduling blocked for [redacted]");
});
