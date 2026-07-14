import type { AgentRuntimeDelegationRole } from "./agent-runtime-control-plane.types.js";

export const agentLiveStatusStates = [
  "running", "waiting", "stalled", "completed", "failed", "blocked", "cancelled", "unknown",
] as const;

export type AgentLiveStatusState = (typeof agentLiveStatusStates)[number];

export const agentLiveStatusPhases = [
  "supervisor", "continuation", "worker", "judge", "integrator", "rejudge", "delivery",
  "validation", "rollback", "approval", "user_input", "none",
] as const;

export type AgentLiveStatusPhase = (typeof agentLiveStatusPhases)[number];

export interface AgentLiveStatus {
  state: AgentLiveStatusState;
  phase: AgentLiveStatusPhase;
  summary: string;
  lastActivityAt: string | null;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  delegationRequestId: string | null;
  role: AgentRuntimeDelegationRole | null;
  taskId: string | null;
  integrationAttemptId: string | null;
  resolvedCandidateCommitSha: string | null;
}
