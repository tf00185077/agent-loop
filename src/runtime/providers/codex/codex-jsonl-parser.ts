import type { AgentObservation } from "../../../domain/index.js";

export interface CodexJsonlParsedResult {
  observations: AgentObservation[];
  finalMessage?: string;
  errorMessage?: string;
  session?: CodexJsonlSessionIdentity;
}

export interface CodexJsonlSessionIdentity {
  sessionId: string;
  cwd?: string;
}

export interface CodexJsonlParser {
  push(chunk: string): CodexJsonlParsedResult[];
  flush(): CodexJsonlParsedResult[];
}

export function createCodexJsonlParser(): CodexJsonlParser {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      return lines.flatMap(parseLine);
    },
    flush() {
      if (!buffer.trim()) {
        buffer = "";
        return [];
      }
      const line = buffer;
      buffer = "";
      return parseLine(line);
    },
  };
}

function parseLine(line: string): CodexJsonlParsedResult[] {
  if (!line.trim()) return [];

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [diagnosticResult("malformed", `Codex emitted malformed JSONL: ${tail(line) ?? ""}`)];
  }
  if (!isRecord(value)) {
    return [diagnosticResult("unknown", `Codex emitted non-object JSONL: ${tail(line) ?? ""}`)];
  }

  const rawEventType = stringValue(value.type) ?? stringValue(value.event);
  if (!rawEventType) {
    return [diagnosticResult("unknown", "Codex emitted JSONL without an event type")];
  }

  const observation = observationFromEvent(rawEventType, value);
  if (!observation) {
    if (isItemEvent(rawEventType)) return [];
    return [diagnosticResult(rawEventType, `Codex emitted unrecognized JSONL event: ${rawEventType}`)];
  }
  return [observation];
}

function observationFromEvent(
  rawEventType: string,
  value: Record<string, unknown>,
): CodexJsonlParsedResult | null {
  if (rawEventType === "thread.started" || rawEventType === "turn.started") {
    const session = sessionIdentityFromEvent(value);
    return {
      observations: [
        {
          kind: "progress",
          message: rawEventType === "thread.started" ? "Codex thread started" : "Codex turn started",
          metadata: jsonlMetadata(rawEventType),
        },
      ],
      session,
    };
  }

  if (rawEventType === "session.started") {
    const session = sessionIdentityFromEvent(value);
    return {
      observations: [
        {
          kind: "progress",
          message: "Codex session started",
          metadata: jsonlMetadata(rawEventType),
        },
      ],
      session,
    };
  }

  if (rawEventType === "item.started") {
    const item = recordValue(value.item);
    if (!isCommandItem(item)) return itemObservation(rawEventType, item);
    return {
      observations: [
        {
          kind: "command.started",
          message: "Command started",
          command: { label: commandLabel(item), status: "started" },
          metadata: jsonlMetadata(rawEventType),
        },
      ],
    };
  }

  if (rawEventType === "item.completed") {
    const item = recordValue(value.item);
    if (!isCommandItem(item)) return itemObservation(rawEventType, item);
    return {
      observations: [
        {
          kind: "command.completed",
          message: "Command completed",
          command: pruneUndefined({
            label: commandLabel(item),
            status: "completed" as const,
            exitCode: numberValue(item.exit_code ?? item.exitCode),
            stdoutTail: tail(stringValue(item.stdout ?? item.aggregated_output ?? item.output)),
            stderrTail: tail(stringValue(item.stderr)),
          }),
          metadata: jsonlMetadata(rawEventType),
        },
      ],
    };
  }

  if (rawEventType === "item.failed") {
    const item = recordValue(value.item);
    if (!isCommandItem(item)) return itemObservation(rawEventType, item);
    const message = stringValue(item.error ?? item.message ?? item.stderr) ?? "Command failed";
    return {
      observations: [
        {
          kind: "command.failed",
          message,
          command: pruneUndefined({
            label: commandLabel(item),
            status: "failed" as const,
            exitCode: numberValue(item.exit_code ?? item.exitCode),
            stderrTail: tail(stringValue(item.stderr ?? item.aggregated_output ?? item.output) ?? message),
          }),
          metadata: jsonlMetadata(rawEventType),
        },
      ],
    };
  }

  if (rawEventType === "agent_message") {
    const message = stringValue(value.message ?? value.text ?? value.content);
    if (!message) return null;
    return {
      observations: [{ kind: "progress", message, metadata: jsonlMetadata(rawEventType) }],
      finalMessage: message,
    };
  }

  if (rawEventType === "error" || rawEventType === "turn.failed") {
    const message = stringValue(value.message ?? value.error) ?? "Codex emitted an error";
    return {
      observations: [
        {
          kind: "command.failed",
          message,
          command: { status: "failed", stderrTail: message },
          metadata: jsonlMetadata(rawEventType),
        },
      ],
      errorMessage: message,
    };
  }

  return null;
}

function itemObservation(
  rawEventType: string,
  item: Record<string, unknown> | null,
): CodexJsonlParsedResult | null {
  const itemType = stringValue(item?.type);
  if (!itemType) return null;

  if (itemType === "agent_message" && rawEventType === "item.completed") {
    const message = stringValue(item?.message ?? item?.text ?? item?.content);
    if (!message) return null;
    return {
      observations: [{ kind: "progress", message, metadata: jsonlMetadata(rawEventType) }],
      finalMessage: message,
    };
  }

  if (itemType === "reasoning") {
    const message = stringValue(item?.text ?? item?.message ?? item?.summary);
    if (!message) return null;
    return {
      observations: [{ kind: "progress", message: `reasoning: ${message}`, metadata: jsonlMetadata(rawEventType) }],
    };
  }

  if (itemType === "tool_use" && rawEventType === "item.started") {
    const name = stringValue(item?.name ?? item?.tool_name ?? item?.toolName);
    return {
      observations: [{
        kind: "progress",
        message: name ? `tool started: ${name}` : "tool started",
        metadata: jsonlMetadata(rawEventType),
      }],
    };
  }

  if (itemType === "tool_use" && rawEventType === "item.completed") {
    const name = stringValue(item?.name ?? item?.tool_name ?? item?.toolName);
    const output = tail(stringValue(item?.output ?? item?.result ?? item?.content));
    const label = name ? `tool completed: ${name}` : "tool completed";
    return {
      observations: [{
        kind: "progress",
        message: output ? `${label}: ${output}` : label,
        metadata: jsonlMetadata(rawEventType),
      }],
    };
  }

  if (itemType === "tool_result" && rawEventType === "item.completed") {
    const content = stringValue(item?.content ?? item?.output ?? item?.result);
    if (!content) return null;
    return {
      observations: [{ kind: "progress", message: `tool result: ${tail(content)}`, metadata: jsonlMetadata(rawEventType) }],
    };
  }

  if (itemType === "file_change" && rawEventType === "item.completed") {
    const summary = stringValue(item?.summary ?? item?.path ?? item?.file);
    return {
      observations: [{
        kind: "progress",
        message: summary ? `file change: ${summary}` : "file change completed",
        metadata: jsonlMetadata(rawEventType),
      }],
    };
  }

  if (itemType === "error") {
    const message = stringValue(item?.message ?? item?.error) ?? "Codex emitted an error";
    return {
      observations: [
        {
          kind: "command.failed",
          message,
          command: { status: "failed", stderrTail: message },
          metadata: jsonlMetadata(rawEventType),
        },
      ],
      errorMessage: message,
    };
  }

  return null;
}

function isItemEvent(rawEventType: string): boolean {
  return rawEventType === "item.started" || rawEventType === "item.completed" || rawEventType === "item.failed";
}

function isCommandItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  const itemType = stringValue(item?.type);
  return itemType === "command" || itemType === "command_execution";
}

function jsonlMetadata(rawEventType: string): AgentObservation["metadata"] {
  return { source: "jsonl", rawEventType };
}

function diagnosticResult(rawEventType: string, message: string): CodexJsonlParsedResult {
  return {
    observations: [
      {
        kind: "progress",
        message,
        metadata: jsonlMetadata(rawEventType),
      },
    ],
  };
}

function commandLabel(item: Record<string, unknown>): string | undefined {
  return stringValue(item.command ?? item.cmd ?? item.label);
}

function sessionIdentityFromEvent(value: Record<string, unknown>): CodexJsonlSessionIdentity | undefined {
  const sessionId = stringValue(
    value.session_id ?? value.sessionId ?? value.thread_id ?? value.threadId ?? value.id,
  );
  if (!sessionId) return undefined;
  return pruneUndefined({
    sessionId,
    cwd: stringValue(value.cwd),
  });
}

function tail(value: string | undefined, maxLength = 500): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pruneUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
