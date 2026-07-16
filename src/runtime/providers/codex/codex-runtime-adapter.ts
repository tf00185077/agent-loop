import { spawn, spawnSync } from "node:child_process";

import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentSessionHandle,
  AgentSessionInput,
  AgentSessionStartInput,
} from "../../../domain/index.js";
import { resolveCodexModelArgument } from "../../../domain/index.js";
import type { AgentObservation } from "../../../domain/index.js";
import { extractControlBlocks } from "../../agent-session/control-block.js";
import { createCodexJsonlParser, type CodexJsonlParsedResult } from "./codex-jsonl-parser.js";

export interface CodexRuntimeAdapterOptions {
  commandPath: string;
  modelLabel: string | null;
  probe?: CodexRuntimeCapabilityProbe;
  sessionRunner?: CodexRuntimeSessionRunner;
}

export interface CodexRuntimeCapabilityDetectionOptions {
  commandPath: string;
  probe?: CodexRuntimeCapabilityProbe;
}

export interface CodexRuntimeCapabilityProbeResult {
  execJson: boolean;
  approvalResume: boolean;
  reason?: string;
}

export type CodexRuntimeCapabilityProbe = (commandPath: string) => Promise<CodexRuntimeCapabilityProbeResult>;

export interface CodexRuntimeSessionRunnerInput extends AgentSessionStartInput {
  commandPath: string;
  signal: AbortSignal;
}

export type CodexRuntimeSessionRunner = (
  input: CodexRuntimeSessionRunnerInput,
) => AsyncIterable<CodexJsonlParsedResult>;

export function createCodexRuntimeAdapter(options: CodexRuntimeAdapterOptions): AgentRuntimeAdapter {
  return {
    providerId: "codex-local",
    detectCapabilities() {
      return detectCodexRuntimeCapabilities(options);
    },
    async startSession(input) {
      return createCodexSessionHandle(options, input);
    },
  };
}

async function createCodexSessionHandle(
  options: CodexRuntimeAdapterOptions,
  input: AgentSessionStartInput,
): Promise<AgentSessionHandle> {
  const capabilities = await detectCodexRuntimeCapabilities(options);
  if (!capabilities.eventStreaming) {
    throw new Error("Codex managed session execution requires verified JSONL session support.");
  }
  const sessionRunner = options.sessionRunner ?? runCodexJsonlSession;

  let cancelled = false;
  const controller = new AbortController();

  return {
    sessionId: input.sessionId,
    capabilities,
    async *events() {
      yield createRuntimeEvent(input, "session.started", "Codex managed session started.");
      let completed = false;
      let providerSessionEmitted = false;

      try {
        for await (const result of sessionRunner({ ...input, commandPath: options.commandPath, signal: controller.signal })) {
          if (cancelled) {
            yield createRuntimeEvent(input, "session.cancelled", "Codex managed session cancelled.");
            return;
          }

          // Surface the Codex-native session id once so the backend can persist it
          // durably for later resume (Phase 4).
          if (result.session?.sessionId && !providerSessionEmitted) {
            providerSessionEmitted = true;
            yield createRuntimeEvent(input, "session.state_changed", "Codex session identity captured.", {
              providerSessionId: result.session.sessionId,
            });
          }

          for (const observation of result.observations) {
            for (const event of observationToRuntimeEvents(input, observation)) {
              yield event;
              if (cancelled) {
                yield createRuntimeEvent(input, "session.cancelled", "Codex managed session cancelled.");
                return;
              }
            }
          }

          if (result.errorMessage) {
            yield createRuntimeEvent(input, "session.failed", result.errorMessage);
            return;
          }

          if (result.finalMessage) {
            completed = true;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Codex managed session failed.";
        yield createRuntimeEvent(input, "session.failed", sanitizeDiagnostic(message));
        return;
      }

      if (cancelled) {
        yield createRuntimeEvent(input, "session.cancelled", "Codex managed session cancelled.");
        return;
      }

      yield createRuntimeEvent(
        input,
        "session.completed",
        completed ? "Codex managed session completed." : "Codex managed session completed without a final message.",
      );
    },
    async send(_message: AgentSessionInput) {},
    async approve() {
      throw new Error("Codex approval resume is not supported by the detected command mode.");
    },
    async reject() {
      throw new Error("Codex approval rejection is not supported by the detected command mode.");
    },
    async cancel() {
      cancelled = true;
      controller.abort();
    },
  };
}

async function* runCodexJsonlSession(input: CodexRuntimeSessionRunnerInput): AsyncIterable<CodexJsonlParsedResult> {
  const request = toSpawnRequest(input.commandPath, buildCodexManagedSessionArgs(input));
  const child = spawn(request.command, request.args, {
    cwd: input.cwd ?? undefined,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const parser = createCodexJsonlParser();
  let stderr = "";

  const closed = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on("error", (err) => {
      reject(new Error(`Codex managed session failed to start: ${sanitizeDiagnostic(err.message)}`));
    });
    child.on("close", (code) => resolve({ code }));
  });
  input.signal.addEventListener("abort", () => child.kill(), { once: true });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input.prompt);

  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    for (const result of parser.push(String(chunk))) {
      yield result;
    }
  }

  for (const result of parser.flush()) {
    yield result;
  }

  const { code } = await closed;
  if (code !== 0) {
    const detail = stderr.trim() ? `: ${sanitizeDiagnostic(stderr.trim())}` : "";
    throw new Error(`Codex managed session exited with code ${code ?? "unknown"}${detail}`);
  }
}

function buildCodexManagedSessionArgs(input: CodexRuntimeSessionRunnerInput): string[] {
  // Pin the sandbox instead of inheriting machine config defaults: managed
  // sessions must write inside their own cwd (workers in isolated worktrees,
  // review merges in the supervisor workspace), and a read-only default
  // silently strands every file-producing delegation.
  const args = ["exec", "--skip-git-repo-check", "--json", "--sandbox", "workspace-write"];
  const modelArgument = resolveCodexModelArgument(input.modelLabel);
  if (modelArgument) {
    args.push("--model", modelArgument);
  }
  args.push("-");
  return args;
}

function observationToRuntimeEvents(input: AgentSessionStartInput, observation: AgentObservation): AgentRuntimeEvent[] {
  if (observation.kind === "command.started") {
    return [
      createRuntimeEvent(input, "command.started", observation.message, {
        commandId: commandIdForObservation(observation),
      }),
    ];
  }
  if (observation.kind === "command.completed") {
    return [
      createRuntimeEvent(input, "command.completed", observation.message, {
        commandId: commandIdForObservation(observation),
      }),
    ];
  }
  if (observation.kind === "command.failed") {
    return [
      createRuntimeEvent(input, "command.failed", observation.message, {
        commandId: commandIdForObservation(observation),
      }),
    ];
  }

  const { blocks, strippedText } = extractControlBlocks(observation.message);
  if (blocks.length === 0) {
    return [createRuntimeEvent(input, "progress", observation.message)];
  }

  const events: AgentRuntimeEvent[] = [];
  if (strippedText) {
    events.push(createRuntimeEvent(input, "progress", strippedText));
  }
  for (const block of blocks) {
    events.push(
      createRuntimeEvent(input, "progress", "Control block received.", {
        delegationControlEvent:
          block.payload !== undefined
            ? block.payload
            : { type: "invalid_control_block", parseError: block.parseError ?? "unparseable" },
      }),
    );
  }
  return events;
}

function createRuntimeEvent(
  input: AgentSessionStartInput,
  type: AgentRuntimeEvent["type"],
  message: string,
  metadata: AgentRuntimeEvent["metadata"] = {},
): AgentRuntimeEvent {
  return {
    type,
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message,
    occurredAt: new Date().toISOString(),
    metadata: {
      providerId: input.providerId,
      modelLabel: input.modelLabel,
      ...metadata,
    },
  };
}

function commandIdForObservation(observation: AgentObservation): string {
  return observation.command?.label ?? "codex-command";
}

export async function detectCodexRuntimeCapabilities(
  options: CodexRuntimeCapabilityDetectionOptions,
): Promise<AgentRuntimeCapabilities> {
  try {
    const result = await (options.probe ?? defaultCodexRuntimeCapabilityProbe)(options.commandPath);
    if (!result.execJson) {
      return {
        eventStreaming: false,
        approval: false,
        cancellation: false,
        resume: false,
        childSessions: false,
        unsupportedReasons: {
          approval: result.reason ?? "Codex approval controls require verified JSONL session event support.",
          cancellation: "Codex cancellation requires JSONL managed session support.",
          resume: "Codex resume requires JSONL managed session support.",
          child_sessions: "Child-session scheduling is not enabled for Codex runtime sessions.",
        },
      };
    }

    return {
      eventStreaming: true,
      approval: result.approvalResume,
      cancellation: true,
      resume: result.approvalResume,
      childSessions: true,
      unsupportedReasons: unsupportedReasonsForSupportedJsonMode(result),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const safeReason = `Codex runtime capability probe failed to start: ${sanitizeDiagnostic(message)}`;
    return {
      eventStreaming: false,
      approval: false,
      cancellation: false,
      resume: false,
      childSessions: false,
      unsupportedReasons: {
        approval: safeReason,
        cancellation: "Codex cancellation requires a successful capability probe.",
        resume: "Codex resume requires a successful capability probe.",
        child_sessions: "Child-session scheduling is not enabled for Codex runtime sessions.",
      },
    };
  }
}

async function defaultCodexRuntimeCapabilityProbe(commandPath: string): Promise<CodexRuntimeCapabilityProbeResult> {
  if (!commandPath.trim()) {
    throw new Error("Codex command path is required");
  }

  const result = spawnSync(commandPath, ["exec", "--help"], {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(commandPath),
    timeout: 5_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const execJson = result.status === 0 && /--json/i.test(output) && /exec|Run Codex non-interactively/i.test(output);

  return {
    execJson,
    approvalResume: false,
    reason: execJson ? undefined : "Codex exec --json is not supported by this CLI.",
  };
}

function unsupportedReasonsForSupportedJsonMode(
  result: CodexRuntimeCapabilityProbeResult,
): AgentRuntimeCapabilities["unsupportedReasons"] {
  const unsupportedReasons: NonNullable<AgentRuntimeCapabilities["unsupportedReasons"]> = {};

  if (!result.approvalResume) {
    unsupportedReasons.approval = "Codex capability probe did not verify backend-mediated approval resume.";
    unsupportedReasons.resume = "Codex capability probe did not verify resumable managed sessions.";
  }

  return unsupportedReasons;
}

function sanitizeDiagnostic(message: string): string {
  return addWindowsShimRetryGuidance(message)
    .replace(/\s+--(api-key|token|access-token)\s+\S+/gi, " --$1 [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/\bhidden\b/gi, "[redacted]");
}

function addWindowsShimRetryGuidance(message: string): string {
  if (
    /npm\.ps1/i.test(message) &&
    /(running scripts is disabled|PSSecurityException|cannot be loaded|not digitally signed)/i.test(message) &&
    !/npm\.cmd/i.test(message)
  ) {
    return `${message} Retry with the Windows executable shim npm.cmd.`;
  }

  return message;
}

function toSpawnRequest(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/c", command, ...args],
    };
  }

  return { command, args };
}
