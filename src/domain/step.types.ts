import type { StepStatus } from "./status.types.js";

export interface Step {
  id: string;
  goalId: string;
  runId: string;
  title: string;
  description: string;
  status: StepStatus;
  order: number;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStepInput {
  goalId: string;
  runId: string;
  title: string;
  description: string;
  order: number;
}

export interface UpdateStepInput {
  title?: string;
  description?: string;
  status?: StepStatus;
  result?: string | null;
}
