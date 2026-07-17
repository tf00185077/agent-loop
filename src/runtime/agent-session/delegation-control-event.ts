import type {
  AgentRuntimeDelegationRole,
  AgentRuntimeSession,
  GoalReassessment,
  ManagedChangePlanEntry,
  ManagedTaskListEntry,
  ManagedReviewDecisionControlEvent,
  ManagedSpecReviewControlEvent,
  ManagedIntegrationResultControlEvent,
  ReassessmentGap,
  AcceptanceCheck,
  TaskAcceptanceCriterion,
  TaskCriterionEvidence,
  TaskTestEvidence,
} from "../../domain/index.js";

export type ManagedIntegrationResultValidation =
  | { ok: true; result: ManagedIntegrationResultControlEvent }
  | { ok: false; safeReason: string };

export function validateManagedIntegrationResult(input: {
  controlEvent: unknown;
  expectedIntegrationAttemptId: string;
  expectedWorkerDelegationRequestId: string;
  expectedOriginalCandidateCommitSha: string;
}): ManagedIntegrationResultValidation {
  const value = input.controlEvent;
  if (!isRecord(value) || value.type !== "managed_integration.result") {
    return { ok: false, safeReason: "Not a managed_integration.result control event." };
  }
  if (value.integrationAttemptId !== input.expectedIntegrationAttemptId) {
    return { ok: false, safeReason: "Integrator result targets a different integration attempt." };
  }
  if (value.workerDelegationRequestId !== input.expectedWorkerDelegationRequestId) {
    return { ok: false, safeReason: "Integrator result targets a different worker attempt." };
  }
  if (value.originalCandidateCommitSha !== input.expectedOriginalCandidateCommitSha) {
    return { ok: false, safeReason: "Integrator result targets a different original candidate." };
  }
  if (typeof value.safeSummary !== "string" || value.safeSummary.trim().length === 0) {
    return { ok: false, safeReason: "Integrator result requires a safe summary." };
  }
  return {
    ok: true,
    result: {
      type: "managed_integration.result",
      integrationAttemptId: input.expectedIntegrationAttemptId,
      workerDelegationRequestId: input.expectedWorkerDelegationRequestId,
      originalCandidateCommitSha: input.expectedOriginalCandidateCommitSha,
      safeSummary: value.safeSummary.trim(),
    },
  };
}

export function selectManagedIntegrationResult(input: {
  controlEvents: unknown[];
  expectedIntegrationAttemptId: string;
  expectedWorkerDelegationRequestId: string;
  expectedOriginalCandidateCommitSha: string;
}): ManagedIntegrationResultValidation {
  const candidates = input.controlEvents.filter(
    (event) => isRecord(event) && event.type === "managed_integration.result",
  );
  if (candidates.length === 0) {
    return { ok: false, safeReason: "Integrator completed without a managed_integration.result block." };
  }
  if (candidates.length > 1) {
    return { ok: false, safeReason: "Integrator emitted more than one managed_integration.result block." };
  }
  return validateManagedIntegrationResult({
    controlEvent: candidates[0],
    expectedIntegrationAttemptId: input.expectedIntegrationAttemptId,
    expectedWorkerDelegationRequestId: input.expectedWorkerDelegationRequestId,
    expectedOriginalCandidateCommitSha: input.expectedOriginalCandidateCommitSha,
  });
}

export interface DelegationControlEventRequest {
  role: AgentRuntimeDelegationRole;
  prompt: string;
  promptSummary: string;
  taskId?: string | null;
  changeId?: string | null;
  acceptance?: TaskAcceptanceCriterion[] | null;
  workerDelegationRequestId?: string | null;
}

export interface ManagedChangePlan {
  changes: ManagedChangePlanEntry[];
}

export interface ManagedTaskResult {
  taskId: string | null;
  criterionEvidence: TaskCriterionEvidence[];
  tests: TaskTestEvidence[];
  claimedFiles: string[];
}

export type ManagedReviewDecisionValidation =
  | { ok: true; decision: ManagedReviewDecisionControlEvent }
  | { ok: false; safeReason: string };

export function validateManagedReviewDecision(input: {
  controlEvent: unknown;
  expectedWorkerDelegationRequestId: string;
  expectedIntegrationAttemptId?: string | null;
  expectedReviewedCandidateCommitSha?: string | null;
  frozenCriteria: TaskAcceptanceCriterion[];
}): ManagedReviewDecisionValidation {
  const value = input.controlEvent;
  if (!isRecord(value) || value.type !== "managed_review.decision") {
    return { ok: false, safeReason: "Not a managed_review.decision control event." };
  }
  if (value.workerDelegationRequestId !== input.expectedWorkerDelegationRequestId) {
    return { ok: false, safeReason: "Judge decision targets a different worker attempt." };
  }
  if (input.expectedIntegrationAttemptId && value.integrationAttemptId !== input.expectedIntegrationAttemptId) {
    return { ok: false, safeReason: "Judge decision targets a different integration attempt." };
  }
  if (input.expectedReviewedCandidateCommitSha &&
      value.reviewedCandidateCommitSha !== input.expectedReviewedCandidateCommitSha) {
    return { ok: false, safeReason: "Judge decision targets a different reviewed candidate." };
  }
  if (value.verdict !== "accepted" && value.verdict !== "rejected" && value.verdict !== "blocked") {
    return { ok: false, safeReason: "Judge verdict must be accepted, rejected, or blocked." };
  }
  if (typeof value.safeSummary !== "string" || value.safeSummary.trim().length === 0 || !Array.isArray(value.decisions)) {
    return { ok: false, safeReason: "Judge decision requires a safe summary and criterion decisions." };
  }
  const decisions: ManagedReviewDecisionControlEvent["decisions"] = [];
  for (const item of value.decisions) {
    if (!isRecord(item) || typeof item.criterionId !== "string" ||
        (item.outcome !== "PASS" && item.outcome !== "FAIL" && item.outcome !== "BLOCKED") ||
        typeof item.safeSummary !== "string" || item.safeSummary.trim().length === 0) {
      return { ok: false, safeReason: "Each judge criterion decision requires criterionId, outcome, and safeSummary." };
    }
    decisions.push({
      criterionId: item.criterionId.trim(),
      outcome: item.outcome,
      safeSummary: item.safeSummary.trim(),
    });
  }
  const expected = new Set(input.frozenCriteria.map((criterion) => criterion.id));
  const actual = new Set(decisions.map((decision) => decision.criterionId));
  if (actual.size !== decisions.length || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) {
    return { ok: false, safeReason: "Judge decision must cover every frozen criterion exactly once." };
  }
  const outcomes = decisions.map((decision) => decision.outcome);
  if (value.verdict === "accepted" && outcomes.some((outcome) => outcome !== "PASS")) {
    return { ok: false, safeReason: "Accepted judge verdict requires every criterion to PASS." };
  }
  if (value.verdict === "rejected" && !outcomes.includes("FAIL")) {
    return { ok: false, safeReason: "Rejected judge verdict requires a FAIL criterion." };
  }
  if (value.verdict === "blocked" && !outcomes.includes("BLOCKED")) {
    return { ok: false, safeReason: "Blocked judge verdict requires a BLOCKED criterion." };
  }
  const deferredFindings = value.deferredFindings === undefined ? [] : value.deferredFindings;
  if (!Array.isArray(deferredFindings) || deferredFindings.some((finding) => typeof finding !== "string")) {
    return { ok: false, safeReason: "Deferred findings must be a list of strings." };
  }
  return {
    ok: true,
    decision: {
      type: "managed_review.decision",
      workerDelegationRequestId: input.expectedWorkerDelegationRequestId,
      ...(input.expectedIntegrationAttemptId ? { integrationAttemptId: input.expectedIntegrationAttemptId } : {}),
      ...(input.expectedReviewedCandidateCommitSha
        ? { reviewedCandidateCommitSha: input.expectedReviewedCandidateCommitSha }
        : {}),
      verdict: value.verdict,
      decisions,
      safeSummary: value.safeSummary.trim(),
      deferredFindings: deferredFindings.map((finding) => (finding as string).trim()).filter(Boolean),
    },
  };
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
      changeId:
        typeof input.controlEvent.changeId === "string" && input.controlEvent.changeId.trim().length > 0
          ? input.controlEvent.changeId.trim()
          : null,
      acceptance: acceptance.criteria,
      workerDelegationRequestId,
    },
  };
}

export type ManagedControlEventValidationResult =
  | { ok: true; kind: "delegation"; request: DelegationControlEventRequest }
  | { ok: true; kind: "completion"; summary: string }
  | { ok: true; kind: "task_list"; tasks: ManagedTaskListEntry[]; changeId: string | null }
  | { ok: true; kind: "task_result"; result: ManagedTaskResult }
  | { ok: true; kind: "change_plan"; plan: ManagedChangePlan }
  | { ok: true; kind: "spec_review"; review: ManagedSpecReviewControlEvent }
  | { ok: true; kind: "reassessment"; reassessment: GoalReassessment }
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
    return validateTaskList(input.controlEvent.tasks, input.controlEvent.changeId);
  }

  if (input.controlEvent.type === "managed_task.result") {
    return validateTaskResult(input.controlEvent);
  }

  if (input.controlEvent.type === "managed_change.plan") {
    return validateChangePlan(input.controlEvent.changes);
  }

  if (input.controlEvent.type === "managed_change.spec_review") {
    return validateSpecReview(input.controlEvent);
  }

  if (input.controlEvent.type === "managed_goal.reassessment") {
    return validateGoalReassessment(input.controlEvent);
  }

  return {
    ok: false,
    safeReason: `Unsupported control event type: ${String(input.controlEvent.type)}.`,
  };
}

function validateSpecReview(
  controlEvent: Record<string, unknown>,
): ManagedControlEventValidationResult {
  if (typeof controlEvent.changeId !== "string" || controlEvent.changeId.trim().length === 0) {
    return { ok: false, safeReason: "Spec review change id must be a non-empty string." };
  }
  if (
    typeof controlEvent.workerDelegationRequestId !== "string" ||
    controlEvent.workerDelegationRequestId.trim().length === 0
  ) {
    return {
      ok: false,
      safeReason: "Spec review worker delegation request id must be a non-empty string.",
    };
  }
  const decision = typeof controlEvent.decision === "string" ? controlEvent.decision.trim() : "";
  if (decision !== "approve" && decision !== "reject") {
    return { ok: false, safeReason: "Spec review decision must be approve or reject." };
  }
  if (typeof controlEvent.summary !== "string" || controlEvent.summary.trim().length === 0) {
    return { ok: false, safeReason: "Spec review summary must be a non-empty string." };
  }
  return {
    ok: true,
    kind: "spec_review",
    review: {
      type: "managed_change.spec_review",
      changeId: controlEvent.changeId.trim(),
      workerDelegationRequestId: controlEvent.workerDelegationRequestId.trim(),
      decision,
      summary: controlEvent.summary.trim(),
    },
  };
}

const MAX_REASSESSMENT_STRING = 500;
const MAX_REASSESSMENT_ITEMS = 20;

function validateGoalReassessment(controlEvent: Record<string, unknown>): ManagedControlEventValidationResult {
  if (typeof controlEvent.goalSatisfied !== "boolean") {
    return { ok: false, safeReason: "Reassessment goalSatisfied must be a boolean." };
  }
  const evidence = normalizeStringList(controlEvent.evidence);
  if (!evidence || evidence.length === 0) {
    return { ok: false, safeReason: "Reassessment requires at least one non-empty evidence string." };
  }
  const remainingGaps = controlEvent.remainingGaps === undefined ? [] : normalizeGapList(controlEvent.remainingGaps);
  if (!remainingGaps) {
    return {
      ok: false,
      safeReason:
        "Reassessment remaining gaps must be objects of the form " +
        '{ "refs": ["<change id | task id | openspec/specs capability | new:<kebab-case>>"], "summary": "<prose>" } ' +
        "with at least one non-empty ref and a non-empty summary each; plain strings are not accepted.",
    };
  }
  if (controlEvent.goalSatisfied && remainingGaps.length > 0) {
    return { ok: false, safeReason: "A satisfied reassessment must not list remaining gaps." };
  }
  if (!controlEvent.goalSatisfied && remainingGaps.length === 0) {
    return { ok: false, safeReason: "An unsatisfied reassessment requires at least one structured remaining gap." };
  }
  const nextEpochRationale =
    typeof controlEvent.nextEpochRationale === "string" && controlEvent.nextEpochRationale.trim().length > 0
      ? controlEvent.nextEpochRationale.trim().slice(0, MAX_REASSESSMENT_STRING)
      : null;
  if (!controlEvent.goalSatisfied && !nextEpochRationale) {
    return { ok: false, safeReason: "An unsatisfied reassessment requires a non-empty nextEpochRationale." };
  }
  return {
    ok: true,
    kind: "reassessment",
    reassessment: {
      goalSatisfied: controlEvent.goalSatisfied,
      evidence,
      remainingGaps,
      nextEpochRationale: controlEvent.goalSatisfied ? null : nextEpochRationale,
    },
  };
}

/** Structured gap shape check; ref resolution stays in the manager. */
function normalizeGapList(value: unknown): ReassessmentGap[] | null {
  if (!Array.isArray(value) || value.length > MAX_REASSESSMENT_ITEMS) return null;
  const gaps: ReassessmentGap[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const summary = typeof entry.summary === "string" ? entry.summary.trim().slice(0, MAX_REASSESSMENT_STRING) : "";
    if (summary.length === 0) return null;
    if (!Array.isArray(entry.refs) || entry.refs.length === 0 || entry.refs.length > MAX_REASSESSMENT_ITEMS) return null;
    const refs: string[] = [];
    for (const ref of entry.refs) {
      if (typeof ref !== "string" || ref.trim().length === 0) return null;
      refs.push(ref.trim().slice(0, MAX_REASSESSMENT_STRING));
    }
    gaps.push({ refs, summary });
  }
  return gaps;
}

/** Trimmed, capped copy of a string list; null when the shape is invalid. */
function normalizeStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) return null;
    items.push(entry.trim().slice(0, MAX_REASSESSMENT_STRING));
  }
  return items.slice(0, MAX_REASSESSMENT_ITEMS);
}

// Minimum of 1: follow-up epochs legitimately need single-change batches
// (e.g. a final verification change) and small planned goals may run one.
const MIN_PLAN_CHANGES = 1;
const MAX_PLAN_CHANGES = 8;

function validateChangePlan(changes: unknown): ManagedControlEventValidationResult {
  if (!Array.isArray(changes) || changes.length < MIN_PLAN_CHANGES || changes.length > MAX_PLAN_CHANGES) {
    return {
      ok: false,
      safeReason: `Change plans must contain between ${MIN_PLAN_CHANGES} and ${MAX_PLAN_CHANGES} changes.`,
    };
  }

  const entries: ManagedChangePlanEntry[] = [];
  const ids = new Set<string>();
  for (const change of changes) {
    if (
      !isRecord(change) ||
      typeof change.id !== "string" ||
      change.id.trim().length === 0 ||
      typeof change.title !== "string" ||
      change.title.trim().length === 0 ||
      typeof change.rationale !== "string" ||
      change.rationale.trim().length === 0
    ) {
      return { ok: false, safeReason: "Plan changes require non-empty id, title, and rationale strings." };
    }
    const id = change.id.trim();
    if (ids.has(id)) {
      return { ok: false, safeReason: "Change ids must be unique within a plan." };
    }
    ids.add(id);
    let dependsOn: string[] | null = null;
    if (change.dependsOn !== undefined && change.dependsOn !== null) {
      if (!Array.isArray(change.dependsOn) || change.dependsOn.some((dep) => typeof dep !== "string" || !dep.trim())) {
        return { ok: false, safeReason: "Change dependencies must be a list of change ids." };
      }
      dependsOn = change.dependsOn.map((dep) => (dep as string).trim());
    }
    entries.push({ id, title: change.title.trim(), rationale: change.rationale.trim(), dependsOn });
  }

  for (const entry of entries) {
    for (const dep of entry.dependsOn ?? []) {
      if (!ids.has(dep)) {
        return { ok: false, safeReason: `Change dependency references an unknown change id: ${dep}.` };
      }
    }
  }
  if (hasDependencyCycle(entries)) {
    return { ok: false, safeReason: "Change dependencies must be acyclic." };
  }

  return { ok: true, kind: "change_plan", plan: { changes: entries } };
}

function hasDependencyCycle(entries: ManagedChangePlanEntry[]): boolean {
  const dependsOn = new Map(entries.map((entry) => [entry.id, entry.dependsOn ?? []]));
  const visiting = new Set<string>();
  const done = new Set<string>();

  function visit(id: string): boolean {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of dependsOn.get(id) ?? []) {
      if (visit(dep)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  }

  return entries.some((entry) => visit(entry.id));
}

function normalizeOptionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function validateTaskList(tasks: unknown, changeId?: unknown): ManagedControlEventValidationResult {
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
  return { ok: true, kind: "task_list", tasks: entries, changeId: normalizeOptionalId(changeId) };
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
    const check = validateAcceptanceCheck(entry.check);
    if (!check.ok) {
      return { ok: false, safeReason: check.safeReason };
    }
    criteria.push({ id, text: entry.text.trim(), ...(check.check ? { check: check.check } : {}) });
  }
  return { ok: true, criteria };
}

const ACCEPTANCE_CHECK_KINDS = new Set(["red_green", "regression", "command"]);
const MAX_CHECK_TIMEOUT_MS = 600_000;

type AcceptanceCheckValidation =
  | { ok: true; check: AcceptanceCheck | null }
  | { ok: false; safeReason: string };

function validateAcceptanceCheck(value: unknown): AcceptanceCheckValidation {
  if (value === undefined || value === null) {
    return { ok: true, check: null };
  }
  if (!isRecord(value)) {
    return { ok: false, safeReason: "Acceptance check must be an object with kind and command." };
  }
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  if (!ACCEPTANCE_CHECK_KINDS.has(kind)) {
    return { ok: false, safeReason: "Acceptance check kind must be red_green, regression, or command." };
  }
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    return { ok: false, safeReason: "Acceptance check command must be a non-empty string." };
  }
  let timeoutMs: number | null = null;
  if (value.timeoutMs !== undefined && value.timeoutMs !== null) {
    if (
      typeof value.timeoutMs !== "number" ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs <= 0 ||
      value.timeoutMs > MAX_CHECK_TIMEOUT_MS
    ) {
      return {
        ok: false,
        safeReason: `Acceptance check timeoutMs must be a positive integer up to ${MAX_CHECK_TIMEOUT_MS}.`,
      };
    }
    timeoutMs = value.timeoutMs;
  }
  let protectedPaths: string[] | null = null;
  if (value.protectedPaths !== undefined && value.protectedPaths !== null) {
    if (
      !Array.isArray(value.protectedPaths) ||
      value.protectedPaths.some((path) => typeof path !== "string" || path.trim().length === 0)
    ) {
      return {
        ok: false,
        safeReason: "Acceptance check protectedPaths must be a list of non-empty repo-relative paths.",
      };
    }
    protectedPaths = value.protectedPaths.map((path) => (path as string).trim());
  }
  return {
    ok: true,
    check: {
      kind: kind as AcceptanceCheck["kind"],
      command: value.command.trim(),
      ...(timeoutMs !== null ? { timeoutMs } : {}),
      ...(protectedPaths ? { protectedPaths } : {}),
    },
  };
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
