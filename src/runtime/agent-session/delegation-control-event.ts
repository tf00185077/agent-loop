import type {
  AgentRuntimeDelegationRole,
  AgentRuntimeSession,
} from "../../domain/index.js";

export interface DelegationControlEventRequest {
  role: AgentRuntimeDelegationRole;
  prompt: string;
  promptSummary: string;
  workerDelegationRequestId?: string | null;
}

export type DelegationControlEventValidationResult =
  | { ok: true; request: DelegationControlEventRequest }
  | { ok: false; safeReason: string };

export interface ValidateDelegationControlEventInput {
  controlEvent: unknown;
  parentSession: AgentRuntimeSession;
}

export function validateDelegationControlEvent(
  input: ValidateDelegationControlEventInput,
): DelegationControlEventValidationResult {
  if (input.parentSession.parent?.sessionId) {
    return { ok: false, safeReason: "Maximum delegation depth reached." };
  }

  if (!isRecord(input.controlEvent)) {
    return { ok: false, safeReason: "Delegation control event must be an object." };
  }
  if (input.controlEvent.type !== "managed_delegation.request") {
    return { ok: false, safeReason: "Unsupported delegation control event type." };
  }
  if (input.controlEvent.role !== "worker" && input.controlEvent.role !== "review_merge") {
    return { ok: false, safeReason: `Unsupported delegation role: ${String(input.controlEvent.role)}.` };
  }
  if (typeof input.controlEvent.prompt !== "string" || input.controlEvent.prompt.trim().length === 0) {
    return { ok: false, safeReason: "Delegation prompt must be a non-empty string." };
  }

  const workerDelegationRequestId =
    typeof input.controlEvent.workerDelegationRequestId === "string" &&
    input.controlEvent.workerDelegationRequestId.trim().length > 0
      ? input.controlEvent.workerDelegationRequestId.trim()
      : null;
  if (input.controlEvent.role === "review_merge" && !workerDelegationRequestId) {
    return { ok: false, safeReason: "Review merge requires a worker delegation result reference." };
  }

  const promptSummary =
    typeof input.controlEvent.summary === "string" && input.controlEvent.summary.trim().length > 0
      ? input.controlEvent.summary.trim()
      : input.controlEvent.prompt.trim();

  return {
    ok: true,
    request: {
      role: input.controlEvent.role,
      prompt: input.controlEvent.prompt.trim(),
      promptSummary,
      workerDelegationRequestId,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
