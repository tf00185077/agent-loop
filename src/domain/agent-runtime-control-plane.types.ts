export const agentSessionLifecycleStates = [
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
] as const;

export type AgentSessionLifecycleState = (typeof agentSessionLifecycleStates)[number];

export const agentRuntimeCapabilityNames = [
  "event_streaming",
  "approval",
  "cancellation",
  "resume",
  "child_sessions",
] as const;

export type AgentRuntimeCapabilityName = (typeof agentRuntimeCapabilityNames)[number];

export interface AgentRuntimeCapabilities {
  eventStreaming: boolean;
  approval: boolean;
  cancellation: boolean;
  resume: boolean;
  childSessions: boolean;
  unsupportedReasons?: Partial<Record<Exclude<AgentRuntimeCapabilityName, "event_streaming">, string>>;
}

export interface AgentRuntimeSessionParent {
  sessionId: string;
  agentId?: string | null;
  taskId?: string | null;
}

export interface AgentRuntimeWorktreeMetadata {
  path: string;
  label: string;
}

export interface AgentRuntimeReviewMergeCheckpoint {
  head: string;
  statusSummary: string;
}

export interface AgentRuntimeReviewMergeApplyOutcome {
  status:
    | "merged"
    | "rejected"
    | "conflict"
    | "test_failed_reverted"
    | "revert_failed"
    | "failed"
    | "verification_failed";
  diffSummary?: string | null;
  safeSummary?: string | null;
}

export interface AgentRuntimeSession {
  id: string;
  goalId: string;
  runId: string;
  providerId: string;
  modelLabel: string | null;
  lifecycleState: AgentSessionLifecycleState;
  capabilities: AgentRuntimeCapabilities;
  createdAt: string;
  lastActivityAt: string;
  parent?: AgentRuntimeSessionParent | null;
  worktree?: AgentRuntimeWorktreeMetadata | null;
}

export const commandRecordStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AgentRuntimeCommandStatus = (typeof commandRecordStatuses)[number];

export interface AgentRuntimeCommandDiagnostics {
  summary: string;
  platform?: string;
  reason?: string;
}

export interface AgentRuntimeCommandRecord {
  id: string;
  sessionId: string;
  status: AgentRuntimeCommandStatus;
  safeCommand: string;
  cwd?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  diagnostics?: AgentRuntimeCommandDiagnostics | null;
}

export const approvalRequestStatuses = ["pending", "approved", "rejected", "cancelled"] as const;

export type AgentRuntimeApprovalStatus = (typeof approvalRequestStatuses)[number];

export interface AgentRuntimeApprovalRequest {
  id: string;
  sessionId: string;
  commandId?: string | null;
  status: AgentRuntimeApprovalStatus;
  safeSummary: string;
  command?: AgentRuntimeCommandRecord | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionReason?: string | null;
}

export const childSessionRequestStatuses = [
  "pending",
  "accepted",
  "rejected",
  "unsupported",
  "completed",
  "failed",
] as const;

export type AgentRuntimeChildSessionRequestStatus = (typeof childSessionRequestStatuses)[number];

export interface AgentRuntimeChildSessionRequest {
  id: string;
  parentSessionId: string;
  parentAgentId?: string | null;
  childRole: string;
  taskId?: string | null;
  promptSummary: string;
  status: AgentRuntimeChildSessionRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  safeReason?: string | null;
}

export const delegationRoles = ["worker", "review_merge"] as const;

export type AgentRuntimeDelegationRole = (typeof delegationRoles)[number];

export const delegationRequestStatuses = [
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
] as const;

export type AgentRuntimeDelegationRequestStatus = (typeof delegationRequestStatuses)[number];

export const delegationTerminalOutcomeTypes = ["success", "failure", "timeout", "cancelled"] as const;

export type AgentRuntimeDelegationTerminalOutcome = (typeof delegationTerminalOutcomeTypes)[number];

export interface AgentRuntimeDelegationSummary {
  kind: AgentRuntimeDelegationTerminalOutcome;
  safeSummary: string;
  safeDetails?: string | null;
  /** Per-criterion evidence reported by the child via managed_task.result. */
  criterionEvidence?: TaskCriterionEvidence[];
  /** Tests the child reports having executed. */
  tests?: TaskTestEvidence[];
  /** Files the child claims it changed. Advisory only. */
  claimedFiles?: string[];
  /** Files attested by the backend from the worker worktree. Authoritative. */
  attestedFiles?: string[];
  /** True when claimedFiles and attestedFiles disagree. */
  filesDiscrepancy?: boolean;
}

export const managedControlEventTypes = [
  "managed_delegation.request",
  "managed_delegation.complete",
  "managed_delegation.task_list",
  "managed_task.result",
] as const;

export type ManagedControlEventType = (typeof managedControlEventTypes)[number];

export interface TaskAcceptanceCriterion {
  /** Immutable criterion identifier, unique within its task (e.g. "A1"). */
  id: string;
  /** Binary, testable condition text. */
  text: string;
}

export interface ManagedDelegationRequestControlEvent {
  type: "managed_delegation.request";
  role: AgentRuntimeDelegationRole;
  prompt: string;
  summary?: string | null;
  taskId?: string | null;
  acceptance?: TaskAcceptanceCriterion[] | null;
  workerDelegationRequestId?: string | null;
}

export interface ManagedDelegationCompleteControlEvent {
  type: "managed_delegation.complete";
  summary: string;
}

export interface ManagedTaskListEntry {
  id: string;
  title: string;
  acceptance?: TaskAcceptanceCriterion[] | null;
}

export interface ManagedTaskListControlEvent {
  type: "managed_delegation.task_list";
  tasks: ManagedTaskListEntry[];
}

export interface TaskCriterionEvidence {
  criterionId: string;
  evidence: string;
}

export interface TaskTestEvidence {
  command: string;
  exitCode: number | null;
  summary?: string | null;
}

export interface ManagedTaskResultControlEvent {
  type: "managed_task.result";
  taskId?: string | null;
  criterionEvidence?: TaskCriterionEvidence[];
  tests?: TaskTestEvidence[];
  claimedFiles?: string[];
}

export type ManagedControlEvent =
  | ManagedDelegationRequestControlEvent
  | ManagedDelegationCompleteControlEvent
  | ManagedTaskListControlEvent
  | ManagedTaskResultControlEvent;

export interface AgentRuntimeDelegationRequest {
  id: string;
  parentSessionId: string;
  childSessionId: string | null;
  role: AgentRuntimeDelegationRole;
  status: AgentRuntimeDelegationRequestStatus;
  promptSummary: string;
  taskId?: string | null;
  /** Frozen acceptance criteria snapshot in force at dispatch. */
  acceptance?: TaskAcceptanceCriterion[] | null;
  resultSummary: AgentRuntimeDelegationSummary | null;
  detachedReason: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type AgentRuntimeEventType =
  | "session.started"
  | "session.state_changed"
  | "progress"
  | "command.started"
  | "command.completed"
  | "command.failed"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "child_session.requested"
  | "session.timed_out"
  | "delegation.accepted"
  | "delegation.rejected"
  | "delegation.started"
  | "delegation.completed"
  | "delegation.failed"
  | "delegation.cancelled"
  | "delegation.timed_out"
  | "delegation.detached"
  | "delegation.ignored"
  | "delegation.waiting_child"
  | "delegation.continuation_started"
  | "session.completed"
  | "session.failed"
  | "session.cancelled";

export interface AgentRuntimeEventMetadata {
  providerId?: string;
  modelLabel?: string | null;
  commandId?: string;
  approvalRequestId?: string;
  childSessionRequestId?: string;
  delegationControlEvent?: unknown;
  delegationRequestId?: string;
  childSessionId?: string;
  reviewMergeApplyOutcome?: AgentRuntimeReviewMergeApplyOutcome;
  agentId?: string;
  parentAgentId?: string;
  taskId?: string;
}

export interface AgentRuntimeEvent {
  type: AgentRuntimeEventType;
  sessionId: string;
  goalId: string;
  runId: string;
  message: string;
  occurredAt: string;
  metadata?: AgentRuntimeEventMetadata;
}

export interface AgentSessionStartInput {
  sessionId: string;
  goalId: string;
  runId: string;
  prompt: string;
  providerId: string;
  modelLabel?: string | null;
  parent?: AgentRuntimeSessionParent | null;
  cwd?: string | null;
}

export type AgentSessionInput =
  | { type: "message"; message: string }
  | { type: "resume"; message?: string };

export interface AgentSessionHandle {
  sessionId: string;
  capabilities: AgentRuntimeCapabilities;
  events(): AsyncIterable<AgentRuntimeEvent>;
  send(input: AgentSessionInput): Promise<void>;
  approve(requestId: string): Promise<void>;
  reject(requestId: string, reason?: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface AgentRuntimeAdapter {
  readonly providerId: string;
  detectCapabilities(): Promise<AgentRuntimeCapabilities>;
  startSession(input: AgentSessionStartInput): Promise<AgentSessionHandle>;
}
