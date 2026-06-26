import type {
  AgentRuntimeApprovalRequest,
  AgentRuntimeChildSessionRequest,
  AgentRuntimeCommandDiagnostics,
  AgentRuntimeCommandRecord,
  AgentRuntimeSession,
} from "../../domain/index.js";
import { sanitizeProcessOutput } from "./process-output-sanitizer.js";

const AUTH_CACHE_PATH_PATTERN =
  /(?:[A-Za-z]:\\[^\s"]*(?:\.codex|\.claude)[^\s"]*|\/[^\s"]*(?:\.codex|\.claude)[^\s"]*)/gi;

export function sanitizeAgentRuntimeApprovalRequest(
  approval: AgentRuntimeApprovalRequest,
): AgentRuntimeApprovalRequest {
  return {
    ...approval,
    safeSummary: sanitizeControlPlaneText(approval.safeSummary),
    command: approval.command ? sanitizeAgentRuntimeCommandRecord(approval.command) : approval.command,
    resolutionReason: sanitizeNullableText(approval.resolutionReason),
  };
}

export function sanitizeAgentRuntimeSession(session: AgentRuntimeSession): AgentRuntimeSession {
  return {
    ...session,
    providerId: sanitizeControlPlaneText(session.providerId),
    modelLabel: sanitizeNullableText(session.modelLabel),
    capabilities: {
      ...session.capabilities,
      unsupportedReasons: session.capabilities.unsupportedReasons
        ? Object.fromEntries(
            Object.entries(session.capabilities.unsupportedReasons).map(([key, value]) => [
              key,
              value ? sanitizeControlPlaneText(value) : value,
            ]),
          )
        : undefined,
    },
  };
}

export function sanitizeAgentRuntimeCommandRecord(
  command: AgentRuntimeCommandRecord,
): AgentRuntimeCommandRecord {
  return {
    ...command,
    safeCommand: sanitizeControlPlaneText(command.safeCommand),
    cwd: command.cwd ? sanitizeAuthCachePath(command.cwd) : command.cwd,
    diagnostics: command.diagnostics
      ? sanitizeAgentRuntimeCommandDiagnostics(command.diagnostics)
      : command.diagnostics,
  };
}

export function sanitizeAgentRuntimeChildSessionRequest(
  request: AgentRuntimeChildSessionRequest,
): AgentRuntimeChildSessionRequest {
  return {
    ...request,
    promptSummary: sanitizeControlPlaneText(request.promptSummary),
    safeReason: sanitizeNullableText(request.safeReason),
  };
}

function sanitizeAgentRuntimeCommandDiagnostics(
  diagnostics: AgentRuntimeCommandDiagnostics,
): AgentRuntimeCommandDiagnostics {
  return {
    ...diagnostics,
    summary: sanitizeControlPlaneText(diagnostics.summary),
    reason: sanitizeNullableText(diagnostics.reason),
  };
}

function sanitizeNullableText<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? sanitizeControlPlaneText(value) : value) as T;
}

function sanitizeControlPlaneText(value: string): string {
  return sanitizeAuthCachePath(sanitizeProcessOutput(value))
    .replace(/\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|AUTH_TOKEN)=[^\s;]+/gi, "[redacted]")
    .trim();
}

function sanitizeAuthCachePath(value: string): string {
  return value.replace(AUTH_CACHE_PATH_PATTERN, "[redacted-auth-cache-path]");
}
