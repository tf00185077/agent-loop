import type { RunStatus } from "./status.types.js";

export interface Run {
  id: string;
  goalId: string;
  status: RunStatus;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface CreateRunInput {
  goalId: string;
  provider: string;
  model: string;
}
