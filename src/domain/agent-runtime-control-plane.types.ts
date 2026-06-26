export const agentSessionLifecycleStates = [
  "starting",
  "running",
  "waiting_approval",
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
  | "session.completed"
  | "session.failed"
  | "session.cancelled";

export interface AgentRuntimeEventMetadata {
  providerId?: string;
  modelLabel?: string | null;
  commandId?: string;
  approvalRequestId?: string;
  childSessionRequestId?: string;
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
