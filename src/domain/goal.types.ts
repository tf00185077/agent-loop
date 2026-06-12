import type { GoalStatus } from "./status.types.js";

export type AgentType = "general";

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  agentType: AgentType;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type GoalPriority = "low" | "normal" | "high";

export interface CreateGoalInput {
  title: string;
  description: string;
  priority?: GoalPriority;
  agentType?: AgentType;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  priority?: GoalPriority;
  agentType?: AgentType;
}
