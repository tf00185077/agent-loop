import type {
  AgentLiveStatus,
  AgentLiveStatusPhase,
  AgentLiveStatusState,
  AgentRuntimeApprovalRequest,
  AgentRuntimeDelegationRequest,
  AgentRuntimeSession,
  Event,
  Goal,
} from "../../domain/index.js";
import type { ManagedTaskContextRecord } from "./managed-context-projection.js";

export interface AgentLiveStatusProjectionInput {
  goal: Goal;
  sessions: AgentRuntimeSession[];
  approvals: AgentRuntimeApprovalRequest[];
  delegations: AgentRuntimeDelegationRequest[];
  managedTasks: ManagedTaskContextRecord[];
  events: Event[];
}

export function projectAgentLiveStatus(input: AgentLiveStatusProjectionInput): AgentLiveStatus {
  const latestSession = latest(input.sessions, (record) => record.lastActivityAt);
  const latestEvent = latest(input.events, (record) => record.createdAt);
  const base = identity(latestSession);
  const activity = latestTimestamp(
    input.goal.updatedAt,
    latestSession?.lastActivityAt,
    latestEvent?.createdAt,
  );

  if (isTerminalGoal(input.goal.status)) {
    return result(base, input.goal.status, "none", latestEvent?.message ?? terminalSummary(input.goal.status),
      latestTimestamp(input.goal.completedAt, activity));
  }

  const pendingApproval = latest(
    input.approvals.filter((record) => record.status === "pending" && record.sessionId === latestSession?.id),
    (record) => record.createdAt,
  );
  if (pendingApproval) {
    return result(base, "waiting", "approval", pendingApproval.safeSummary,
      latestTimestamp(pendingApproval.createdAt, activity));
  }

  if (input.goal.status === "waiting_user" || latestSession?.lifecycleState === "waiting_input") {
    return result(base, "waiting", "user_input", latestEvent?.message ?? "Waiting for user input", activity);
  }

  const integrationTask = [...input.managedTasks].reverse().find((task) =>
    task.lastIntegrationStatus !== null && task.lastIntegrationStatus !== "committed" &&
    task.lastIntegrationStatus !== "rejected" && task.lastIntegrationStatus !== "blocked");
  if (integrationTask) {
    const integration = integrationProjection(integrationTask);
    if (integration) return taskResult(base, integrationTask, integration.state, integration.phase, activity);
  }

  const activeDelegation = latest(
    input.delegations.filter((record) => ["requested", "accepted", "running"].includes(record.status)),
    (record) => record.updatedAt,
  );
  if (activeDelegation) {
    const child = input.sessions.find((record) => record.id === activeDelegation.childSessionId);
    const delegatedBase = identity(child ?? latestSession, activeDelegation.parentSessionId);
    const phase = delegationPhase(activeDelegation, input.managedTasks);
    return {
      ...result(delegatedBase, "waiting", phase, activeDelegation.promptSummary,
        latestTimestamp(activeDelegation.updatedAt, child?.lastActivityAt, activity)),
      delegationRequestId: activeDelegation.id,
      role: activeDelegation.role,
      taskId: activeDelegation.taskId ?? null,
    };
  }

  const deliveryTask = [...input.managedTasks].reverse().find((task) =>
    task.lastDeliveryStatus !== null && task.lastDeliveryStatus !== "committed" && task.lastDeliveryStatus !== "rejected");
  if (deliveryTask) {
    const delivery = deliveryProjection(deliveryTask.lastDeliveryStatus!);
    return taskResult(base, deliveryTask, delivery.state, delivery.phase, activity);
  }

  const managedTask = [...input.managedTasks].reverse().find((task) =>
    task.status === "awaiting_review" || task.status === "awaiting_delivery");
  if (managedTask) {
    return taskResult(base, managedTask, managedTask.status === "awaiting_review" ? "waiting" : "running",
      managedTask.status === "awaiting_review" ? "judge" : "delivery", activity);
  }

  if (latestSession) {
    const sessionProjection = projectSession(latestSession, input.sessions.length > 1);
    return result(base, sessionProjection.state, sessionProjection.phase,
      latestEvent?.message ?? sessionProjection.summary, activity);
  }

  return result(base, input.goal.status === "running" ? "running" : "unknown",
    input.goal.status === "running" ? "supervisor" : "none",
    latestEvent?.message ?? "No active managed session", activity);
}

function integrationProjection(task: ManagedTaskContextRecord): { state: AgentLiveStatusState; phase: AgentLiveStatusPhase } | null {
  switch (task.lastIntegrationStatus) {
    case "pending":
    case "resolving": return { state: "waiting", phase: "integrator" };
    case "awaiting_review": return { state: "waiting", phase: "rejudge" };
    case "accepted": return { state: "running", phase: "delivery" };
    case "resolution_failed":
    case "interrupted": return { state: "stalled", phase: "integrator" };
    default: return null;
  }
}

function deliveryProjection(status: NonNullable<ManagedTaskContextRecord["lastDeliveryStatus"]>): {
  state: AgentLiveStatusState; phase: AgentLiveStatusPhase;
} {
  if (status === "test_failed_reverted" || status === "revert_failed") return { state: "stalled", phase: "rollback" };
  if (status === "verification_failed" || status === "failed" || status === "integration_failed") {
    return { state: "stalled", phase: "validation" };
  }
  return { state: status === "pending" ? "running" : "stalled", phase: "delivery" };
}

function delegationPhase(request: AgentRuntimeDelegationRequest, tasks: ManagedTaskContextRecord[]): AgentLiveStatusPhase {
  if (request.role === "worker") return "worker";
  if (request.role === "integrator") return "integrator";
  return tasks.some((task) => task.id === request.taskId && task.lastIntegrationStatus === "awaiting_review") ? "rejudge" : "judge";
}

function projectSession(session: AgentRuntimeSession, isContinuation: boolean): {
  state: AgentLiveStatusState; phase: AgentLiveStatusPhase; summary: string;
} {
  switch (session.lifecycleState) {
    case "starting":
    case "running": return { state: "running", phase: isContinuation ? "continuation" : "supervisor", summary: "Supervisor is running" };
    case "waiting_approval": return { state: "waiting", phase: "approval", summary: "Waiting for approval" };
    case "waiting_input": return { state: "waiting", phase: "user_input", summary: "Waiting for user input" };
    case "waiting_child": return { state: "waiting", phase: "supervisor", summary: "Waiting for delegated work" };
    case "stalled": return { state: "stalled", phase: "supervisor", summary: "Managed session is stalled" };
    case "cancelling": return { state: "waiting", phase: "supervisor", summary: "Cancellation is in progress" };
    case "cancelled": return { state: "cancelled", phase: "none", summary: "Managed session was cancelled" };
    case "failed": return { state: "failed", phase: "none", summary: "Managed session failed" };
    case "completed": return { state: "completed", phase: "none", summary: "Managed session completed" };
    default: return { state: "unknown", phase: "none", summary: "Unknown managed session state" };
  }
}

function taskResult(base: AgentLiveStatus, task: ManagedTaskContextRecord, state: AgentLiveStatusState,
  phase: AgentLiveStatusPhase, activity: string | null): AgentLiveStatus {
  return {
    ...result(base, state, phase, task.lastSafeSummary || task.title, activity),
    taskId: task.id,
    integrationAttemptId: task.integrationAttemptId,
    resolvedCandidateCommitSha: task.resolvedCandidateCommitSha,
  };
}

function identity(session?: AgentRuntimeSession, parentSessionId?: string): AgentLiveStatus {
  return {
    state: "unknown", phase: "none", summary: "", lastActivityAt: session?.lastActivityAt ?? null,
    provider: session?.providerId ?? null, model: session?.modelLabel ?? null, sessionId: session?.id ?? null,
    parentSessionId: parentSessionId ?? session?.parent?.sessionId ?? null, delegationRequestId: null, role: null,
    taskId: session?.parent?.taskId ?? null, integrationAttemptId: null, resolvedCandidateCommitSha: null,
  };
}

function result(base: AgentLiveStatus, state: AgentLiveStatusState, phase: AgentLiveStatusPhase,
  summary: string, lastActivityAt: string | null): AgentLiveStatus {
  return { ...base, state, phase, summary: bounded(summary), lastActivityAt };
}

function latest<T>(values: T[], timestamp: (value: T) => string): T | undefined {
  return [...values].sort((a, b) => timestamp(a).localeCompare(timestamp(b))).at(-1);
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isTerminalGoal(status: Goal["status"]): status is "completed" | "failed" | "blocked" | "cancelled" {
  return ["completed", "failed", "blocked", "cancelled"].includes(status);
}

function terminalSummary(status: "completed" | "failed" | "blocked" | "cancelled"): string {
  return `Goal ${status}`;
}
