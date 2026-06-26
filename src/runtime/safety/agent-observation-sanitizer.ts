import type { AgentObservation } from "../../domain/index.js";
import { sanitizeProcessOutput } from "./process-output-sanitizer.js";

export type UnsanitizedAgentObservation = AgentObservation & {
  rawPayload?: unknown;
};

export function sanitizeAgentObservation(
  observation: UnsanitizedAgentObservation,
): AgentObservation {
  return pruneEmpty({
    kind: observation.kind,
    message: sanitizeProcessOutput(observation.message).trim(),
    metadata: observation.metadata ? pruneEmpty({ ...observation.metadata }) : undefined,
    command: observation.command
      ? pruneEmpty({
          label: sanitizeOptionalText(observation.command.label),
          status: observation.command.status,
          exitCode: observation.command.exitCode,
          stdoutTail: sanitizeOptionalText(observation.command.stdoutTail),
          stderrTail: sanitizeOptionalText(observation.command.stderrTail),
        })
      : undefined,
    subtask: observation.subtask
      ? pruneEmpty({
          title: sanitizeOptionalText(observation.subtask.title),
          status: observation.subtask.status,
          summary: sanitizeOptionalText(observation.subtask.summary),
        })
      : undefined,
  });
}

function sanitizeOptionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeProcessOutput(value).trim();
}

function pruneEmpty<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined || entry === "") return false;
      if (isPlainObject(entry) && Object.keys(entry).length === 0) return false;
      return true;
    }),
  ) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
