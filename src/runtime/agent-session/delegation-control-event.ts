import type {
  AgentRuntimeDelegationRole,
  AgentRuntimeSession,
  ManagedTaskListEntry,
  TaskAcceptanceCriterion,
  TaskCriterionEvidence,
  TaskTestEvidence,
} from "../../domain/index.js";

export interface DelegationControlEventRequest {
  role: AgentRuntimeDelegationRole;
  prompt: string;
  promptSummary: string;
  taskId?: string | null;
  acceptance?: TaskAcceptanceCriterion[] | null;
  workerDelegationRequestId?: string | null;
}

export interface ManagedTaskResult {
  taskId: string | null;
  criterionEvidence: TaskCriterionEvidence[];
  tests: TaskTestEvidence[];
  claimedFiles: string[];
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
  const acceptance = validateAcceptanceCriteria(input.controlEvent.acceptance);
  if (!acceptance.ok) {
    return { ok: false, safeReason: acceptance.safeReason };
  }

  return {
    ok: true,
    request: {
      role: input.controlEvent.role,
      prompt: input.controlEvent.prompt.trim(),
      promptSummary,
      taskId,
      acceptance: acceptance.criteria,
      workerDelegationRequestId,
    },
  };
}

export type ManagedControlEventValidationResult =
  | { ok: true; kind: "delegation"; request: DelegationControlEventRequest }
  | { ok: true; kind: "completion"; summary: string }
  | { ok: true; kind: "task_list"; tasks: ManagedTaskListEntry[] }
  | { ok: true; kind: "task_result"; result: ManagedTaskResult }
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

  if (input.controlEvent.type === "managed_task.result") {
    return validateTaskResult(input.controlEvent);
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
    const acceptance = validateAcceptanceCriteria(task.acceptance);
    if (!acceptance.ok) {
      return { ok: false, safeReason: acceptance.safeReason };
    }
    const parentTaskId =
      typeof task.parentTaskId === "string" && task.parentTaskId.trim().length > 0
        ? task.parentTaskId.trim()
        : null;
    entries.push({
      id: task.id.trim(),
      title: task.title.trim(),
      acceptance: acceptance.criteria,
      parentTaskId,
    });
  }
  return { ok: true, kind: "task_list", tasks: entries };
}

type AcceptanceValidation =
  | { ok: true; criteria: TaskAcceptanceCriterion[] | null }
  | { ok: false; safeReason: string };

function validateAcceptanceCriteria(value: unknown): AcceptanceValidation {
  if (value === undefined || value === null) {
    return { ok: true, criteria: null };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, safeReason: "Acceptance criteria must be a non-empty list when present." };
  }
  const criteria: TaskAcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0 ||
      typeof entry.text !== "string" ||
      entry.text.trim().length === 0
    ) {
      return { ok: false, safeReason: "Acceptance criteria require non-empty id and text strings." };
    }
    const id = entry.id.trim();
    if (seen.has(id)) {
      return { ok: false, safeReason: "Acceptance criterion ids must be unique within a task." };
    }
    seen.add(id);
    criteria.push({ id, text: entry.text.trim() });
  }
  return { ok: true, criteria };
}

export type ManagedTaskResultValidation =
  | { ok: true; result: ManagedTaskResult }
  | { ok: false; safeReason: string };

/** Validate a child-emitted managed_task.result payload in isolation. */
export function validateManagedTaskResult(controlEvent: unknown): ManagedTaskResultValidation {
  if (!isRecord(controlEvent) || controlEvent.type !== "managed_task.result") {
    return { ok: false, safeReason: "Not a managed_task.result control event." };
  }
  const validated = validateTaskResult(controlEvent);
  if (!validated.ok) {
    return validated;
  }
  if (validated.kind !== "task_result") {
    return { ok: false, safeReason: "Not a managed_task.result control event." };
  }
  return { ok: true, result: validated.result };
}

function validateTaskResult(controlEvent: Record<string, unknown>): ManagedControlEventValidationResult {
  const taskId =
    typeof controlEvent.taskId === "string" && controlEvent.taskId.trim().length > 0
      ? controlEvent.taskId.trim()
      : null;

  const criterionEvidence: TaskCriterionEvidence[] = [];
  if (controlEvent.criterionEvidence !== undefined) {
    if (!Array.isArray(controlEvent.criterionEvidence)) {
      return { ok: false, safeReason: "Criterion evidence must be a list when present." };
    }
    for (const entry of controlEvent.criterionEvidence) {
      if (
        !isRecord(entry) ||
        typeof entry.criterionId !== "string" ||
        entry.criterionId.trim().length === 0 ||
        typeof entry.evidence !== "string" ||
        entry.evidence.trim().length === 0
      ) {
        return {
          ok: false,
          safeReason: "Criterion evidence entries require non-empty criterionId and evidence strings.",
        };
      }
      criterionEvidence.push({ criterionId: entry.criterionId.trim(), evidence: entry.evidence.trim() });
    }
  }

  const tests: TaskTestEvidence[] = [];
  if (controlEvent.tests !== undefined) {
    if (!Array.isArray(controlEvent.tests)) {
      return { ok: false, safeReason: "Test evidence must be a list when present." };
    }
    for (const entry of controlEvent.tests) {
      if (!isRecord(entry) || typeof entry.command !== "string" || entry.command.trim().length === 0) {
        return { ok: false, safeReason: "Test evidence entries require a non-empty command string." };
      }
      tests.push({
        command: entry.command.trim(),
        exitCode: typeof entry.exitCode === "number" ? entry.exitCode : null,
        summary: typeof entry.summary === "string" ? entry.summary : null,
      });
    }
  }

  const claimedFiles: string[] = [];
  if (controlEvent.claimedFiles !== undefined) {
    if (!Array.isArray(controlEvent.claimedFiles)) {
      return { ok: false, safeReason: "Claimed files must be a list when present." };
    }
    for (const entry of controlEvent.claimedFiles) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return { ok: false, safeReason: "Claimed file entries must be non-empty strings." };
      }
      claimedFiles.push(entry.trim());
    }
  }

  return { ok: true, kind: "task_result", result: { taskId, criterionEvidence, tests, claimedFiles } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
