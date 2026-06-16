const BASE = "/api";

export interface Goal {
  id: string;
  title: string;
  description: string;
  priority: string;
  agentType: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  blockedAt: string | null;
}

export interface GoalEvent {
  id: string;
  goalId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
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
  priority: string;
  agentType: string;
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
