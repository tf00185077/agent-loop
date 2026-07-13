import { spawn, spawnSync } from "node:child_process";

import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentSessionHandle,
  AgentSessionStartInput,
} from "../../../domain/index.js";
import { extractControlBlocks } from "../../agent-session/control-block.js";

export interface ClaudeRuntimeAdapterOptions {
  commandPath: string;
  modelLabel: string | null;
  /** Hard timeout for a single Claude turn. Defaults to 10 minutes. */
  timeoutMs?: number;
  probe?: ClaudeRuntimeCapabilityProbe;
  sessionRunner?: ClaudeRuntimeSessionRunner;
}

export interface ClaudeRuntimeCapabilityDetectionOptions {
  commandPath: string;
  probe?: ClaudeRuntimeCapabilityProbe;
}

export interface ClaudeRuntimeCapabilityProbeResult {
  printMode: boolean;
  reason?: string;
}

export type ClaudeRuntimeCapabilityProbe = (
  commandPath: string,
) => Promise<ClaudeRuntimeCapabilityProbeResult>;

export interface ClaudeRuntimeSessionRunnerInput extends AgentSessionStartInput {
  commandPath: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Runs one non-interactive Claude turn and resolves with the full stdout text. */
export type ClaudeRuntimeSessionRunner = (input: ClaudeRuntimeSessionRunnerInput) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 600_000;

export function createClaudeRuntimeAdapter(options: ClaudeRuntimeAdapterOptions): AgentRuntimeAdapter {
  return {
    providerId: "claude-local",
    detectCapabilities() {
      return detectClaudeRuntimeCapabilities(options);
    },
    async startSession(input) {
      return createClaudeSessionHandle(options, input);
    },
  };
}

async function createClaudeSessionHandle(
  options: ClaudeRuntimeAdapterOptions,
  input: AgentSessionStartInput,
): Promise<AgentSessionHandle> {
  const capabilities = await detectClaudeRuntimeCapabilities(options);
  if (!capabilities.eventStreaming) {
    throw new Error("Claude managed session execution requires verified print-mode support.");
  }
  const sessionRunner = options.sessionRunner ?? runClaudePrintSession;

  let cancelled = false;
  const controller = new AbortController();

  return {
    sessionId: input.sessionId,
    capabilities,
    async *events() {
      yield createRuntimeEvent(input, "session.started", "Claude managed session started.");
      if (cancelled) {
        yield createRuntimeEvent(input, "session.cancelled", "Claude managed session cancelled.");
        return;
      }

      let text: string;
      try {
        text = await sessionRunner({
          ...input,
          commandPath: options.commandPath,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: controller.signal,
        });
      } catch (err) {
        if (cancelled) {
          yield createRuntimeEvent(input, "session.cancelled", "Claude managed session cancelled.");
          return;
        }
        const message = err instanceof Error ? err.message : "Claude managed session failed.";
        yield createRuntimeEvent(input, "session.failed", sanitizeDiagnostic(message));
        return;
      }

      if (cancelled) {
        yield createRuntimeEvent(input, "session.cancelled", "Claude managed session cancelled.");
        return;
      }

      const { blocks, strippedText } = extractControlBlocks(text);
      if (strippedText) {
        yield createRuntimeEvent(input, "progress", strippedText);
      }
      for (const block of blocks) {
        yield createRuntimeEvent(input, "progress", "Control block received.", {
          delegationControlEvent:
            block.payload !== undefined
              ? block.payload
              : { type: "invalid_control_block", parseError: block.parseError ?? "unparseable" },
        });
      }

      yield createRuntimeEvent(input, "session.completed", "Claude managed session completed.");
    },
    async send() {},
    async approve() {
      throw new Error("Claude print mode does not support backend-mediated approvals.");
    },
    async reject() {
      throw new Error("Claude print mode does not support backend-mediated approvals.");
    },
    async cancel() {
      cancelled = true;
      controller.abort();
    },
  };
}

export function buildClaudeManagedSessionArgs(modelLabel: string | null): string[] {
  const args = ["--print", "--output-format", "text"];
  const model = modelLabel?.trim();
  if (model) {
    args.push("--model", model);
  }
  return args;
}

function runClaudePrintSession(input: ClaudeRuntimeSessionRunnerInput): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new Error("Claude managed session cancelled"));
      return;
    }
    const request = toSpawnRequest(input.commandPath, buildClaudeManagedSessionArgs(input.modelLabel ?? null));
    const child = spawn(request.command, request.args, {
      cwd: input.cwd ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Claude managed session timed out"));
    }, input.timeoutMs);

    input.signal.addEventListener(
      "abort",
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(new Error("Claude managed session cancelled"));
      },
      { once: true },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Claude managed session failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Claude managed session exited with code ${code}: ${stderr.trim() || "no stderr"}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(input.prompt);
  });
}

export async function detectClaudeRuntimeCapabilities(
  options: ClaudeRuntimeCapabilityDetectionOptions,
): Promise<AgentRuntimeCapabilities> {
  try {
    const result = await (options.probe ?? defaultClaudeRuntimeCapabilityProbe)(options.commandPath);
    if (!result.printMode) {
      return unsupportedCapabilities(result.reason ?? "Claude print mode support could not be verified.");
    }

    return {
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: true,
      unsupportedReasons: {
        approval: "Claude print mode does not support backend-mediated approvals.",
        resume: "Claude true resume is not supported in v1; continuations restart with a fresh contract prompt.",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return unsupportedCapabilities(
      `Claude runtime capability probe failed to start: ${sanitizeDiagnostic(message)}`,
    );
  }
}

function unsupportedCapabilities(reason: string): AgentRuntimeCapabilities {
  return {
    eventStreaming: false,
    approval: false,
    cancellation: false,
    resume: false,
    childSessions: false,
    unsupportedReasons: {
      approval: reason,
      cancellation: "Claude cancellation requires managed print-mode support.",
      resume: "Claude resume requires managed print-mode support.",
      child_sessions: "Child-session scheduling requires managed print-mode support.",
    },
  };
}

async function defaultClaudeRuntimeCapabilityProbe(
  commandPath: string,
): Promise<ClaudeRuntimeCapabilityProbeResult> {
  if (!commandPath.trim()) {
    throw new Error("Claude command path is required");
  }

  const result = spawnSync(commandPath, ["--help"], {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(commandPath),
    timeout: 5_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const printMode = result.status === 0 && /--print/i.test(output);

  return {
    printMode,
    reason: printMode ? undefined : "Claude --print mode is not supported by this CLI.",
  };
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

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\s+--(api-key|token|access-token)\s+\S+/gi, " --$1 [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]");
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
