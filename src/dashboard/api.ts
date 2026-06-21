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
    };

export type SaveProviderSettingsInput =
  | {
      provider: "mock";
    }
  | {
      provider: "codex-local";
      modelLabel: string;
      codexCommandPath: string | null;
    };

export interface CodexCliDetectionResult {
  detected: boolean;
  commandPath: string | null;
  source: "manual" | "path" | "common" | "none";
  status: ProviderStatus;
}

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

export async function startGoal(id: string): Promise<void> {
  const res = await fetch(`${BASE}/goals/${id}/start`, { method: "POST" });
  if (!res.ok) throw new Error(`startGoal: ${res.status}`);
}

export async function listEvents(id: string): Promise<GoalEvent[]> {
  const res = await fetch(`${BASE}/goals/${id}/events`);
  if (!res.ok) throw new Error(`listEvents: ${res.status}`);
  return res.json();
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

export async function detectCodexCli(): Promise<CodexCliDetectionResult> {
  const res = await fetch(`${BASE}/provider-settings/detect`, {
    method: "POST",
  });
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
