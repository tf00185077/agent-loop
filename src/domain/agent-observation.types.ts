import type { CreateEventInput, EventData, EventType } from "./event.types.js";

export const agentObservationEventTypes = [
  "agent.heartbeat",
  "agent.progress",
  "agent.command.started",
  "agent.command.completed",
  "agent.command.failed",
  "agent.subtask.started",
  "agent.subtask.completed",
  "agent.subtask.failed",
] as const satisfies readonly EventType[];

export type AgentObservationEventType = (typeof agentObservationEventTypes)[number];

export type AgentObservationKind =
  | "heartbeat"
  | "progress"
  | "command.started"
  | "command.completed"
  | "command.failed"
  | "subtask.started"
  | "subtask.completed"
  | "subtask.failed";

export type AgentObservationSource = "stdout" | "stderr" | "jsonl" | "provider" | "runtime";

export interface AgentObservationMetadata {
  provider?: string;
  model?: string;
  agentRole?: string;
  agentId?: string;
  parentAgentId?: string;
  taskId?: string;
  source?: AgentObservationSource | string;
  rawEventType?: string;
}

export interface AgentCommandObservation {
  label?: string;
  status?: "started" | "completed" | "failed";
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface AgentSubtaskObservation {
  title?: string;
  status?: "started" | "completed" | "failed";
  summary?: string;
}

export interface AgentObservation {
  kind: AgentObservationKind;
  message: string;
  metadata?: AgentObservationMetadata;
  command?: AgentCommandObservation;
  subtask?: AgentSubtaskObservation;
}

export interface CreateAgentObservationEventInputOptions {
  goalId: string;
  runId?: string | null;
  stepId?: string | null;
  observation: AgentObservation;
}

export function createAgentObservationEventInput(
  options: CreateAgentObservationEventInputOptions,
): CreateEventInput {
  const { goalId, runId, stepId, observation } = options;
  return {
    goalId,
    runId,
    stepId,
    type: observationKindToEventType(observation.kind),
    message: observation.message,
    data: buildAgentObservationEventData(observation),
  };
}

export function observationKindToEventType(kind: AgentObservationKind): AgentObservationEventType {
  return `agent.${kind}` as AgentObservationEventType;
}

export function buildAgentObservationEventData(observation: AgentObservation): EventData {
  return withoutUndefined({
    observationKind: observation.kind,
    ...observation.metadata,
    command: observation.command ? withoutUndefined(observation.command) : undefined,
    subtask: observation.subtask ? withoutUndefined(observation.subtask) : undefined,
  });
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""),
  ) as T;
}
