import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRuntimeCapabilityNames,
  agentSessionLifecycleStates,
  approvalRequestStatuses,
  childSessionRequestStatuses,
  commandRecordStatuses,
  type AgentRuntimeCapabilities,
  type AgentRuntimeCommandRecord,
  type AgentRuntimeApprovalRequest,
  type AgentRuntimeChildSessionRequest,
  type AgentRuntimeEvent,
  type AgentRuntimeSession,
} from "./agent-runtime-control-plane.types.js";

test("defines managed session lifecycle states in control-plane order", () => {
  assert.deepEqual(agentSessionLifecycleStates, [
    "starting",
    "running",
    "waiting_approval",
    "waiting_input",
    "stalled",
    "cancelling",
    "cancelled",
    "failed",
    "completed",
  ]);
});

test("defines runtime capability names for provider-independent controls", () => {
  assert.deepEqual(agentRuntimeCapabilityNames, [
    "event_streaming",
    "approval",
    "cancellation",
    "resume",
    "child_sessions",
  ]);
});

test("represents managed sessions with provider model lifecycle and parent metadata", () => {
  const capabilities: AgentRuntimeCapabilities = {
    eventStreaming: true,
    approval: false,
    cancellation: true,
    resume: false,
    childSessions: false,
    unsupportedReasons: {
      approval: "Codex exec mode cannot resume a dashboard-mediated approval.",
    },
  };

  const session: AgentRuntimeSession = {
    id: "session-1",
    goalId: "goal-1",
    runId: "run-1",
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "waiting_approval",
    capabilities,
    createdAt: "2026-06-26T00:00:00.000Z",
    lastActivityAt: "2026-06-26T00:00:05.000Z",
    parent: {
      sessionId: "parent-session",
      agentId: "agent-parent",
      taskId: "task-7",
    },
  };

  assert.equal(session.lifecycleState, "waiting_approval");
  assert.equal(session.capabilities.approval, false);
  assert.equal(session.parent?.agentId, "agent-parent");
});

test("represents command records approval requests and child-session metadata", () => {
  assert.deepEqual(commandRecordStatuses, ["pending", "running", "completed", "failed", "cancelled"]);
  assert.deepEqual(approvalRequestStatuses, ["pending", "approved", "rejected", "cancelled"]);
  assert.deepEqual(childSessionRequestStatuses, [
    "pending",
    "accepted",
    "rejected",
    "unsupported",
    "completed",
    "failed",
  ]);

  const command: AgentRuntimeCommandRecord = {
    id: "command-1",
    sessionId: "session-1",
    status: "running",
    safeCommand: "npm.cmd test",
    cwd: "C:\\Users\\TIM\\Desktop\\self\\auto-agent",
    startedAt: "2026-06-26T00:00:01.000Z",
    completedAt: null,
    exitCode: null,
    diagnostics: {
      summary: "PowerShell shim blocked; retry with npm.cmd.",
      platform: "win32",
    },
  };

  const approval: AgentRuntimeApprovalRequest = {
    id: "approval-1",
    sessionId: "session-1",
    commandId: command.id,
    status: "pending",
    safeSummary: "Run test command",
    command,
    createdAt: "2026-06-26T00:00:02.000Z",
    resolvedAt: null,
    resolutionReason: null,
  };

  const childRequest: AgentRuntimeChildSessionRequest = {
    id: "child-request-1",
    parentSessionId: "session-1",
    parentAgentId: "agent-main",
    childRole: "reviewer",
    taskId: "task-8",
    promptSummary: "Review runtime manager implementation.",
    status: "unsupported",
    createdAt: "2026-06-26T00:00:03.000Z",
    resolvedAt: "2026-06-26T00:00:04.000Z",
    safeReason: "Child-session scheduling is not enabled.",
  };

  assert.equal(approval.command?.safeCommand, "npm.cmd test");
  assert.equal(childRequest.parentSessionId, approval.sessionId);
});

test("represents runtime events with session provider and optional control metadata", () => {
  const event: AgentRuntimeEvent = {
    type: "approval.requested",
    sessionId: "session-1",
    goalId: "goal-1",
    runId: "run-1",
    message: "Approval requested",
    occurredAt: "2026-06-26T00:00:02.000Z",
    metadata: {
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      commandId: "command-1",
      approvalRequestId: "approval-1",
      agentId: "agent-main",
      parentAgentId: "agent-parent",
      taskId: "task-7",
    },
  };

  assert.equal(event.metadata?.approvalRequestId, "approval-1");
});
