import type {
  AgentRuntimeApprovalRequest,
  AgentRuntimeChildSessionRequest,
  AgentRuntimeSession,
} from "../domain/index.js";

const BASE = "/api";

export interface Goal {
  id: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high";
  agentType: "general";
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GoalEvent {
  id: string;
  goalId: string;
  runId: string | null;
  stepId: string | null;
  type: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AgentSessionSnapshot {
  session: AgentRuntimeSession | null;
  approvals: AgentRuntimeApprovalRequest[];
  childSessionRequests: AgentRuntimeChildSessionRequest[];
}

export type ProviderConnectionState =
  | "not_checked"
  | "detected"
  | "not_found"
  | "connected"
  | "login_required"
  | "network_failure"
  | "command_failure";

export interface ProviderStatus {
  state: ProviderConnectionState;
  detected: boolean;
  checkedAt: string | null;
  message: string | null;
}

export type ProviderSettings =
  | {
      provider: "mock";
      modelLabel: "mock-v1";
      codexCommandPath: null;
      status: ProviderStatus;
    }
  | {
      provider: "codex-local";
      modelLabel: string;
      codexCommandPath: string | null;
      status: ProviderStatus;
    }
  | {
      provider: "claude-local";
      modelLabel: string;
      claudeCommandPath: string | null;
      status: ProviderStatus;
    };

export type SaveProviderSettingsInput =
  | {
      provider: "mock";
    }
  | {
      provider: "codex-local";
      modelLabel: string;
      codexCommandPath: string | null;
    }
  | {
      provider: "claude-local";
      modelLabel: string;
      claudeCommandPath: string | null;
    };

export type StartGoalProviderOverride =
  | {
      provider: "mock";
    }
  | {
      provider: "codex-local";
      modelLabel: string;
      codexCommandPath: string | null;
    }
  | {
      provider: "claude-local";
      modelLabel: string;
      claudeCommandPath: string | null;
    };

export interface StartGoalOptions {
  providerOverride?: StartGoalProviderOverride;
}

export interface CodexCliDetectionResult {
  detected: boolean;
  commandPath: string | null;
  source: "manual" | "path" | "common" | "none";
  status: ProviderStatus;
}

export type DetectProviderInput =
  | {
      provider: "codex-local";
      codexCommandPath: string | null;
    }
  | {
      provider: "claude-local";
      claudeCommandPath: string | null;
    };

export interface CodexLocalConnectionTestResult {
  status: ProviderStatus;
}

export interface CodexModelCatalogEntry {
  slug: string;
  displayName: string;
  description: string | null;
  priority: number;
}

export type CodexModelCatalogStatusState = "available" | "empty" | "unavailable";

export interface CodexModelCatalogStatus {
  state: CodexModelCatalogStatusState;
  checkedAt: string | null;
  message: string | null;
  /** Raw Codex CLI output/error for failed lookups, shown for debugging. */
  detail?: string | null;
}

export interface CodexModelCatalogResult {
  models: CodexModelCatalogEntry[];
  defaultModelSlug: string | null;
  source: "manual" | "path" | "common" | "none";
  status: CodexModelCatalogStatus;
}

export async function listGoals(): Promise<Goal[]> {
  const res = await fetch(`${BASE}/goals`);
  if (!res.ok) throw new Error(`listGoals: ${res.status}`);
  return res.json();
}

export async function getGoal(id: string): Promise<Goal> {
  const res = await fetch(`${BASE}/goals/${id}`);
  if (!res.ok) throw new Error(`getGoal: ${res.status}`);
  return res.json();
}

export async function createGoal(body: {
  title: string;
  description: string;
  priority: Goal["priority"];
  agentType: Goal["agentType"];
}): Promise<Goal> {
  const res = await fetch(`${BASE}/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createGoal: ${res.status}`);
  return res.json();
}

export async function startGoal(id: string, options?: StartGoalOptions): Promise<void> {
  const init: RequestInit = options?.providerOverride
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerOverride: options.providerOverride }),
      }
    : { method: "POST" };
  const res = await fetch(`${BASE}/goals/${id}/start`, init);
  if (!res.ok) throw new Error(`startGoal: ${res.status}`);
}

export async function listEvents(id: string): Promise<GoalEvent[]> {
  const res = await fetch(`${BASE}/goals/${id}/events`);
  if (!res.ok) throw new Error(`listEvents: ${res.status}`);
  return res.json();
}

export async function getAgentSessionSnapshot(id: string): Promise<AgentSessionSnapshot> {
  const res = await fetch(`${BASE}/goals/${id}/agent-session`);
  if (!res.ok) throw new Error(`getAgentSessionSnapshot: ${res.status}`);
  return res.json();
}

export async function approveAgentSessionApproval(sessionId: string, approvalId: string): Promise<void> {
  const res = await fetch(`${BASE}/agent-sessions/${sessionId}/approvals/${approvalId}/approve`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`approveAgentSessionApproval: ${res.status}`);
}

export async function rejectAgentSessionApproval(
  sessionId: string,
  approvalId: string,
  reason?: string,
): Promise<void> {
  const res = await fetch(`${BASE}/agent-sessions/${sessionId}/approvals/${approvalId}/reject`, {
    method: "POST",
    headers: reason ? { "Content-Type": "application/json" } : undefined,
    body: reason ? JSON.stringify({ reason }) : undefined,
  });
  if (!res.ok) throw new Error(`rejectAgentSessionApproval: ${res.status}`);
}

export async function cancelAgentSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE}/agent-sessions/${sessionId}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`cancelAgentSession: ${res.status}`);
}

export function openEventStream(id: string, onEvent: (event: GoalEvent) => void): () => void {
  const source = new EventSource(`${BASE}/goals/${id}/events/stream`);
  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data));
  };
  return () => source.close();
}

export async function getProviderSettings(): Promise<ProviderSettings> {
  const res = await fetch(`${BASE}/provider-settings`);
  if (!res.ok) throw new Error(`getProviderSettings: ${res.status}`);
  return res.json();
}

export async function saveProviderSettings(
  body: SaveProviderSettingsInput,
): Promise<ProviderSettings> {
  const res = await fetch(`${BASE}/provider-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`saveProviderSettings: ${res.status}`);
  return res.json();
}

export async function detectCodexCli(input?: DetectProviderInput): Promise<CodexCliDetectionResult> {
  const init: RequestInit = input
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    : { method: "POST" };
  const res = await fetch(`${BASE}/provider-settings/detect`, init);
  if (!res.ok) throw new Error(`detectCodexCli: ${res.status}`);
  return res.json();
}

export async function testCodexLocalConnection(): Promise<CodexLocalConnectionTestResult> {
  const res = await fetch(`${BASE}/provider-settings/test`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`testCodexLocalConnection: ${res.status}`);
  return res.json();
}

export async function loadCodexModelCatalog(): Promise<CodexModelCatalogResult> {
  const res = await fetch(`${BASE}/provider-settings/models`);
  if (!res.ok) throw new Error(`loadCodexModelCatalog: ${res.status}`);
  return res.json();
}
