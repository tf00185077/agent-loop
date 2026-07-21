import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentRuntimeApprovalRequest,
  AgentRuntimeDelegationRequest,
  AgentRuntimeSession,
  Event,
  Goal,
} from "../../domain/index.js";
import type { ManagedTaskContextRecord } from "./managed-context-projection.js";
import { projectAgentLiveStatus } from "./agent-live-status.js";

test("terminal goal state outranks pending work", () => {
  const status = projectAgentLiveStatus({
    goal: goal({ status: "completed", completedAt: "2026-07-14T01:04:00Z" }),
    sessions: [session({ lifecycleState: "waiting_approval" })],
    approvals: [approval()],
    delegations: [delegation({ status: "running" })],
    managedTasks: [],
    events: [],
  });

  assert.equal(status.state, "completed");
  assert.equal(status.phase, "none");
  assert.equal(status.lastActivityAt, "2026-07-14T01:04:00Z");
});

test("pending approval outranks active integration and exposes bounded safe context", () => {
  const status = projectAgentLiveStatus({
    goal: goal(),
    sessions: [session()],
    approvals: [approval({ safeSummary: `  Approve   ${"x".repeat(600)}  ` })],
    delegations: [],
    managedTasks: [managedTask({ lastIntegrationStatus: "resolving" })],
    events: [],
  });

  assert.equal(status.state, "waiting");
  assert.equal(status.phase, "approval");
  assert.equal(status.summary.length, 500);
  assert.equal(status.sessionId, "session-1");
});

test("durable integration state selects integrator, rejudge, validation, and rollback phases", () => {
  const base = { goal: goal(), sessions: [session()], approvals: [], delegations: [], events: [] };
  const cases: Array<[ManagedTaskContextRecord, string, string]> = [
    [managedTask({ lastIntegrationStatus: "resolving" }), "waiting", "integrator"],
    [managedTask({ lastIntegrationStatus: "awaiting_review" }), "waiting", "rejudge"],
    [managedTask({ lastDeliveryStatus: "verification_failed" }), "stalled", "validation"],
    [managedTask({ lastDeliveryStatus: "test_failed_reverted" }), "stalled", "rollback"],
  ];

  for (const [task, state, phase] of cases) {
    const status = projectAgentLiveStatus({ ...base, managedTasks: [task] });
    assert.equal(status.state, state);
    assert.equal(status.phase, phase);
    assert.equal(status.taskId, "task-1");
  }
});

test("active delegation identifies worker identity and child model", () => {
  const status = projectAgentLiveStatus({
    goal: goal(),
    sessions: [session(), session({ id: "child-1", providerId: "codex", modelLabel: "gpt-5", parent: { sessionId: "session-1", taskId: "task-1" } })],
    approvals: [],
    delegations: [delegation({ childSessionId: "child-1" })],
    managedTasks: [],
    events: [],
  });

  assert.equal(status.phase, "worker");
  assert.equal(status.delegationRequestId, "delegation-1");
  assert.equal(status.sessionId, "child-1");
  assert.equal(status.parentSessionId, "session-1");
  assert.equal(status.provider, "codex");
  assert.equal(status.model, "gpt-5");
});

test("projection is deterministic from the same durable records after restart", () => {
  const input = {
    goal: goal(),
    sessions: [session()],
    approvals: [],
    delegations: [],
    managedTasks: [managedTask({ lastIntegrationStatus: "resolution_failed" })],
    events: [],
  };

  assert.deepEqual(projectAgentLiveStatus(structuredClone(input)), projectAgentLiveStatus(structuredClone(input)));
});

test("session and managed-task fallbacks cover input, stalled, continuation, judge, and delivery", () => {
  const base = { goal: goal(), approvals: [], delegations: [], events: [] };
  const cases: Array<[Parameters<typeof projectAgentLiveStatus>[0], string, string]> = [
    [{ ...base, sessions: [session({ lifecycleState: "waiting_input" })], managedTasks: [] }, "waiting", "user_input"],
    [{ ...base, sessions: [session({ lifecycleState: "stalled" })], managedTasks: [] }, "stalled", "supervisor"],
    [{ ...base, sessions: [session({ id: "old", lifecycleState: "completed" }), session()], managedTasks: [] }, "running", "continuation"],
    [{ ...base, sessions: [session()], managedTasks: [managedTask({ status: "awaiting_review", integrationAttemptId: null })] }, "waiting", "judge"],
    [{ ...base, sessions: [session()], managedTasks: [managedTask({ status: "awaiting_delivery", integrationAttemptId: null })] }, "running", "delivery"],
  ];
  for (const [input, state, phase] of cases) {
    const status = projectAgentLiveStatus(input);
    assert.equal(status.state, state);
    assert.equal(status.phase, phase);
  }
});

test("original and candidate-bound review delegations select judge and rejudge", () => {
  const base = { goal: goal(), sessions: [session()], approvals: [], events: [] };
  const original = projectAgentLiveStatus({
    ...base, delegations: [delegation({ role: "review_merge" })], managedTasks: [managedTask()],
  });
  const candidate = projectAgentLiveStatus({
    ...base, delegations: [delegation({ role: "review_merge" })],
    managedTasks: [managedTask({ lastIntegrationStatus: "awaiting_review" })],
  });
  assert.equal(original.phase, "judge");
  assert.equal(candidate.phase, "rejudge");
});

test("structured delivery outranks stale completion prose but active delegation outranks delivery", () => {
  const staleEvent = event({ type: "agent.message", message: "Everything completed successfully" });
  const delivery = managedTask({ status: "awaiting_delivery", lastDeliveryStatus: "pending", integrationAttemptId: null });
  const projected = projectAgentLiveStatus({
    goal: goal(), sessions: [session()], approvals: [], delegations: [], managedTasks: [delivery], events: [staleEvent],
  });
  assert.equal(projected.phase, "delivery");
  assert.equal(projected.summary, "Integration needs attention");

  const delegated = projectAgentLiveStatus({
    goal: goal(), sessions: [session()], approvals: [], delegations: [delegation()], managedTasks: [delivery], events: [staleEvent],
  });
  assert.equal(delegated.phase, "worker");
});

test("historical goal without runtime metadata remains renderable", () => {
  const status = projectAgentLiveStatus({ goal: goal({ status: "draft", startedAt: null }), sessions: [], approvals: [], delegations: [], managedTasks: [], events: [] });
  assert.equal(status.state, "unknown");
  assert.equal(status.phase, "none");
  assert.equal(status.sessionId, null);
  assert.equal(status.provider, null);
  assert.equal(status.model, null);
});

test("future session lifecycle falls back without crashing", () => {
  const futureSession = session();
  futureSession.lifecycleState = "future_lifecycle" as never;
  const status = projectAgentLiveStatus({
    goal: goal(), sessions: [futureSession], approvals: [], delegations: [], managedTasks: [], events: [],
  });
  assert.equal(status.state, "unknown");
  assert.equal(status.phase, "none");
  assert.equal(status.sessionId, "session-1");
});

test("pending approval from an older session cannot hide the current continuation", () => {
  const current = session({ id: "session-current", createdAt: "2026-07-14T01:05:00Z", lastActivityAt: "2026-07-14T01:06:00Z" });
  const status = projectAgentLiveStatus({
    goal: goal(),
    sessions: [session({ id: "session-old" }), current],
    approvals: [approval({ sessionId: "session-old" })],
    delegations: [], managedTasks: [], events: [],
  });
  assert.equal(status.state, "running");
  assert.equal(status.phase, "continuation");
  assert.equal(status.sessionId, "session-current");
});

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1", title: "Goal", description: "", status: "running", priority: "normal", agentType: "general",
 confirmationPolicy: "off",
 workspace: null,
    createdAt: "2026-07-14T01:00:00Z", updatedAt: "2026-07-14T01:01:00Z", startedAt: "2026-07-14T01:00:00Z", completedAt: null,
    ...overrides,
  };
}

function session(overrides: Partial<AgentRuntimeSession> = {}): AgentRuntimeSession {
  return {
    id: "session-1", goalId: "goal-1", runId: "run-1", providerId: "mock", modelLabel: "mock",
    lifecycleState: "running", capabilities: { eventStreaming: true, approval: true, cancellation: true, resume: true, childSessions: true },
    createdAt: "2026-07-14T01:00:00Z", lastActivityAt: "2026-07-14T01:03:00Z", parent: null,
    ...overrides,
  };
}

function approval(overrides: Partial<AgentRuntimeApprovalRequest> = {}): AgentRuntimeApprovalRequest {
  return {
    id: "approval-1", sessionId: "session-1", status: "pending", safeSummary: "Approve command",
    createdAt: "2026-07-14T01:02:00Z", resolvedAt: null, ...overrides,
  };
}

function delegation(overrides: Partial<AgentRuntimeDelegationRequest> = {}): AgentRuntimeDelegationRequest {
  return {
    id: "delegation-1", parentSessionId: "session-1", childSessionId: null, role: "worker", status: "running",
    promptSummary: "Implement task", taskId: "task-1", resultSummary: null, detachedReason: null,
    createdAt: "2026-07-14T01:01:00Z", updatedAt: "2026-07-14T01:03:00Z", acceptedAt: "2026-07-14T01:01:00Z",
    startedAt: "2026-07-14T01:02:00Z", completedAt: null, ...overrides,
  };
}

function managedTask(overrides: Partial<ManagedTaskContextRecord> = {}): ManagedTaskContextRecord {
  return {
    id: "task-1", title: "Task", status: "delegated", parentTaskId: null, attemptCount: 1,
    substantiveRejectionCount: 0, lastCitedCriteria: [], lastSafeSummary: "Integration needs attention", criteria: [],
    lastJudgeVerdict: null, lastDeliveryStatus: null, lastIntegrationStatus: null,
    integrationAttemptId: "integration-1", resolvedCandidateCommitSha: "candidate-1", ...overrides,
  };
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "event-1", goalId: "goal-1", runId: "run-1", stepId: null, type: "agent.progress",
    message: "Progress", data: {}, createdAt: "2026-07-14T01:04:00Z", ...overrides,
  };
}
