import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRuntimeCapabilityNames,
  agentSessionLifecycleStates,
  approvalRequestStatuses,
  childSessionRequestStatuses,
  delegationRequestStatuses,
  delegationRoles,
  delegationTerminalOutcomeTypes,
  managedTaskStatuses,
  managedCriterionOutcomes,
  managedJudgeVerdicts,
  managedDeliveryOutcomes,
  managedIntegrationStatuses,
  managedCompletionGapTypes,
  managedControlEventTypes,
  commandRecordStatuses,
  type AgentRuntimeCapabilities,
  type AgentRuntimeCommandRecord,
  type AgentRuntimeApprovalRequest,
  type AgentRuntimeChildSessionRequest,
  type AgentRuntimeEvent,
  type AgentRuntimeSession,
  type AgentRuntimeDelegationRequest,
  type AgentRuntimeDelegationSummary,
  type ManagedIntegrationResultControlEvent,
  type ManagedTaskIntegrationRecord,
  type ManagedTaskReviewRecord,
} from "./agent-runtime-control-plane.types.js";
import {
  agentRuntimeCapabilityNames as publicAgentRuntimeCapabilityNames,
  agentLiveStatusPhases,
  agentLiveStatusStates,
  type AgentLiveStatus,
  type AgentRuntimeAdapter as PublicAgentRuntimeAdapter,
} from "./index.js";

test("defines the closed live status contract and nullable safe metadata", () => {
  assert.deepEqual(agentLiveStatusStates, [
    "running", "waiting", "stalled", "completed", "failed", "blocked", "cancelled", "unknown",
  ]);
  assert.deepEqual(agentLiveStatusPhases, [
    "supervisor", "continuation", "worker", "judge", "integrator", "rejudge", "delivery",
    "validation", "rollback", "approval", "user_input", "none",
  ]);
  const fixture: AgentLiveStatus = {
    state: "unknown", phase: "none", summary: "No session", lastActivityAt: null,
    provider: null, model: null, sessionId: null, parentSessionId: null, delegationRequestId: null,
    role: null, taskId: null, integrationAttemptId: null, resolvedCandidateCommitSha: null,
  };
  assert.equal(fixture.sessionId, null);
});

test("defines managed session lifecycle states in control-plane order", () => {
  assert.deepEqual(agentSessionLifecycleStates, [
    "starting",
    "running",
    "waiting_approval",
    "waiting_child",
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

test("exports control-plane contracts from the public domain index", () => {
  const adapter = {
    providerId: "codex-local",
    detectCapabilities: async () => ({
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: false,
    }),
    startSession: async () => {
      throw new Error("not used by this type-level export test");
    },
  } satisfies PublicAgentRuntimeAdapter;

  assert.equal(adapter.providerId, "codex-local");
  assert.deepEqual(publicAgentRuntimeCapabilityNames, agentRuntimeCapabilityNames);
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

test("represents durable managed delegation contracts", () => {
  assert.deepEqual(delegationRoles, ["worker", "review_merge", "integrator"]);
  assert.deepEqual(delegationRequestStatuses, [
    "requested",
    "accepted",
    "rejected",
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "detached",
    "ignored",
  ]);
  assert.deepEqual(delegationTerminalOutcomeTypes, ["success", "failure", "timeout", "cancelled"]);

  const summary: AgentRuntimeDelegationSummary = {
    kind: "failure",
    safeSummary: "Worker could not complete npm test.",
    safeDetails: "Exit code 1.",
  };
  const request: AgentRuntimeDelegationRequest = {
    id: "delegation-1",
    parentSessionId: "session-supervisor",
    childSessionId: "session-worker",
    role: "worker",
    status: "failed",
    promptSummary: "Run focused tests.",
    resultSummary: summary,
    detachedReason: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:01.000Z",
    acceptedAt: "2026-07-03T00:00:01.000Z",
    startedAt: "2026-07-03T00:00:02.000Z",
    completedAt: "2026-07-03T00:00:03.000Z",
  };

  const event: AgentRuntimeEvent = {
    type: "delegation.failed",
    sessionId: request.parentSessionId,
    goalId: "goal-1",
    runId: "run-1",
    message: "Worker delegation failed.",
    occurredAt: request.completedAt!,
    metadata: {
      delegationRequestId: request.id,
      childSessionId: request.childSessionId!,
    },
  };

  assert.equal(request.resultSummary?.kind, "failure");
  assert.equal(event.metadata?.delegationRequestId, request.id);
});

test("defines closed durable task decision vocabularies", () => {
  assert.deepEqual(managedTaskStatuses, [
    "registered",
    "delegated",
    "awaiting_review",
    "rejected",
    "split",
    "failed",
    "blocked",
    "awaiting_delivery",
    "accepted",
  ]);
  assert.deepEqual(managedCriterionOutcomes, ["UNKNOWN", "PASS", "FAIL", "BLOCKED"]);
  assert.deepEqual(managedJudgeVerdicts, ["accepted", "rejected", "blocked"]);
  assert.deepEqual(managedDeliveryOutcomes, [
    "pending",
    "committed",
    "rejected",
    "conflict",
    "integration_failed",
    "test_failed_reverted",
    "revert_failed",
    "failed",
    "verification_failed",
  ]);
  assert.deepEqual(managedIntegrationStatuses, [
    "pending",
    "resolving",
    "awaiting_review",
    "accepted",
    "rejected",
    "blocked",
    "resolution_failed",
    "interrupted",
    "committed",
  ]);
  assert.deepEqual(managedCompletionGapTypes, [
    "unaccepted_leaf_task",
    "criterion_not_passed",
    "active_attempt",
    "pending_review",
    "pending_delivery",
    "pending_integration",
    "undelivered_changes",
    "uncontracted_only_work",
    "unarchived_change",
    "invalid_split_lineage",
  ]);
});

test("includes the caller-dialogue control block types", () => {
  assert.ok(managedControlEventTypes.includes("managed_goal.request_input"));
  assert.ok(managedControlEventTypes.includes("managed_goal.propose_plan"));
  assert.ok(managedControlEventTypes.includes("managed_goal.ready_to_proceed"));
});

test("binds integration results and Judge records to an exact candidate", () => {
  assert.ok(managedControlEventTypes.includes("managed_integration.result"));

  const result: ManagedIntegrationResultControlEvent = {
    type: "managed_integration.result",
    integrationAttemptId: "integration-1",
    workerDelegationRequestId: "worker-1",
    originalCandidateCommitSha: "candidate-1",
    safeSummary: "Resolved the accepted candidate against the checkpoint.",
  };
  const integration: ManagedTaskIntegrationRecord = {
    id: result.integrationAttemptId,
    taskId: "task-1",
    workerDelegationRequestId: result.workerDelegationRequestId,
    integratorDelegationRequestId: "integrator-1",
    status: "awaiting_review",
    checkpointHead: "base-1",
    originalCandidateCommitSha: result.originalCandidateCommitSha,
    resolvedCandidateCommitSha: "candidate-2",
    conflictFiles: ["src/a.ts"],
    allowedFiles: ["src/a.ts"],
    safeSummary: result.safeSummary,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
  };
  const review: ManagedTaskReviewRecord = {
    id: "review-2",
    taskId: integration.taskId,
    workerDelegationRequestId: integration.workerDelegationRequestId,
    judgeDelegationRequestId: "judge-2",
    integrationAttemptId: integration.id,
    reviewedCandidateCommitSha: integration.resolvedCandidateCommitSha,
    verdict: "accepted",
    decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    citedCriteria: ["A1"],
    safeSummary: "Resolved candidate accepted.",
    deferredFindings: [],
    createdAt: "2026-07-14T00:00:02.000Z",
  };

  assert.equal(review.reviewedCandidateCommitSha, integration.resolvedCandidateCommitSha);
});
