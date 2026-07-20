import type { GoalStatus } from "./status.types.js";

export type AgentType = "general";

/**
 * Whether the supervisor must obtain a standing caller confirmation before
 * doing work. Caller-owned and invisible to the supervisor; defaults `off`
 * because confirmation friction is only warranted for ambiguous goals.
 */
export type ConfirmationPolicy = "off" | "required";

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  agentType: AgentType;
  confirmationPolicy: ConfirmationPolicy;
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
  confirmationPolicy?: ConfirmationPolicy;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  priority?: GoalPriority;
  agentType?: AgentType;
}
