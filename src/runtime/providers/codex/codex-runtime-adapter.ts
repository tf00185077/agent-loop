import { spawnSync } from "node:child_process";

import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
} from "../../../domain/index.js";

export interface CodexRuntimeAdapterOptions {
  commandPath: string;
  modelLabel: string | null;
  probe?: CodexRuntimeCapabilityProbe;
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

export function createCodexRuntimeAdapter(options: CodexRuntimeAdapterOptions): AgentRuntimeAdapter {
  return {
    providerId: "codex-local",
    detectCapabilities() {
      return detectCodexRuntimeCapabilities(options);
    },
    async startSession() {
      throw new Error("Codex managed session execution is not implemented yet.");
    },
  };
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
      childSessions: false,
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
  const unsupportedReasons: NonNullable<AgentRuntimeCapabilities["unsupportedReasons"]> = {
    child_sessions: "Child-session scheduling is not enabled for Codex runtime sessions.",
  };

  if (!result.approvalResume) {
    unsupportedReasons.approval = "Codex capability probe did not verify backend-mediated approval resume.";
    unsupportedReasons.resume = "Codex capability probe did not verify resumable managed sessions.";
  }

  return unsupportedReasons;
}

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\s+--(api-key|token|access-token)\s+\S+/gi, " --$1 [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/\bhidden\b/gi, "[redacted]");
}
