import type {
  AgentRuntimeDelegationRole,
  AgentRuntimeSession,
  ManagedTaskListEntry,
} from "../../domain/index.js";

export interface DelegationControlEventRequest {
  role: AgentRuntimeDelegationRole;
  prompt: string;
  promptSummary: string;
  taskId?: string | null;
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
  const taskId =
    typeof input.controlEvent.taskId === "string" && input.controlEvent.taskId.trim().length > 0
      ? input.controlEvent.taskId.trim()
      : null;

  return {
    ok: true,
    request: {
      role: input.controlEvent.role,
      prompt: input.controlEvent.prompt.trim(),
      promptSummary,
      taskId,
      workerDelegationRequestId,
    },
  };
}

export type ManagedControlEventValidationResult =
  | { ok: true; kind: "delegation"; request: DelegationControlEventRequest }
  | { ok: true; kind: "completion"; summary: string }
  | { ok: true; kind: "task_list"; tasks: ManagedTaskListEntry[] }
  | { ok: false; safeReason: string };

export function validateManagedControlEvent(
  input: ValidateDelegationControlEventInput,
): ManagedControlEventValidationResult {
  if (!isRecord(input.controlEvent)) {
    return { ok: false, safeReason: "Delegation control event must be an object." };
  }

  if (input.controlEvent.type === "managed_delegation.request") {
    const result = validateDelegationControlEvent(input);
    return result.ok ? { ok: true, kind: "delegation", request: result.request } : result;
  }

  if (input.controlEvent.type === "managed_delegation.complete") {
    if (
      typeof input.controlEvent.summary !== "string" ||
      input.controlEvent.summary.trim().length === 0
    ) {
      return { ok: false, safeReason: "Completion summary must be a non-empty string." };
    }
    return { ok: true, kind: "completion", summary: input.controlEvent.summary.trim() };
  }

  if (input.controlEvent.type === "managed_delegation.task_list") {
    return validateTaskList(input.controlEvent.tasks);
  }

  return {
    ok: false,
    safeReason: `Unsupported control event type: ${String(input.controlEvent.type)}.`,
  };
}

function validateTaskList(tasks: unknown): ManagedControlEventValidationResult {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, safeReason: "Task list must contain at least one task." };
  }
  const entries: ManagedTaskListEntry[] = [];
  for (const task of tasks) {
    if (
      !isRecord(task) ||
      typeof task.id !== "string" ||
      task.id.trim().length === 0 ||
      typeof task.title !== "string" ||
      task.title.trim().length === 0
    ) {
      return { ok: false, safeReason: "Task list entries require non-empty id and title strings." };
    }
    entries.push({ id: task.id.trim(), title: task.title.trim() });
  }
  return { ok: true, kind: "task_list", tasks: entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
