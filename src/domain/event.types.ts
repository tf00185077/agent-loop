export type EventType =
  | "goal.created"
  | "run.started"
  | "step.started"
  | "agent.decision"
  | "agent.message"
  | "scope.voted"
  | "gate.voted"
  | "step.completed"
  | "run.completed"
  | "goal.completed"
  | "goal.blocked"
  | "error";

export interface Event {
  id: string;
  goalId: string;
  runId: string | null;
  stepId: string | null;
  type: EventType;
  message: string;
  data: EventData;
  createdAt: string;
}

export type EventData = Record<string, unknown>;

export interface CreateEventInput {
  goalId: string;
  runId?: string | null;
  stepId?: string | null;
  type: EventType;
  message: string;
  data?: EventData;
}
