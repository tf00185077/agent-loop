import type { Event, ManagedChangePlanEntry, ManagedTaskStatus } from "../../domain/index.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { GoalChangeRegistry, specTaskId } from "./change-registry.js";
import { GoalTaskRegistry, type CriterionOutcome, type TaskRecord, type TaskStatus } from "./task-registry.js";

/**
 * Rebuild the in-memory supervisor working caches from durable rows so a resumed
 * session gates and continues against the same state it had before the crash.
 * The durable ledger (managed_tasks + change events) remains authoritative; these
 * functions only repopulate the registries.
 */
export function rehydrateTaskRegistry(
  taskRegistry: GoalTaskRegistry,
  managedTaskRepo: ManagedTaskRepository,
  goalId: string,
): void {
  const records: TaskRecord[] = managedTaskRepo.listForGoal(goalId).map((task) => {
    const criteria = managedTaskRepo.listCriteria(goalId, task.id);
    return {
      id: task.id,
      title: task.title,
      acceptance: criteria.length > 0 ? criteria.map((c) => ({ id: c.criterionId, text: c.text })) : null,
      status: toTaskStatus(task.status),
      attemptCount: task.attemptCount,
      substantiveRejections: task.substantiveRejectionCount,
      lastCitedCriteria: task.lastCitedCriteria,
      criterionOutcomes: Object.fromEntries(criteria.map((c) => [c.criterionId, toCriterionOutcome(c.outcome)])),
      parentTaskId: task.parentTaskId,
      lastOutcomeSummary: task.lastSafeSummary,
    };
  });
  taskRegistry.hydrate(records);
}

export function rehydrateChangeRegistry(
  changeRegistry: GoalChangeRegistry,
  managedTaskRepo: ManagedTaskRepository,
  goalId: string,
  events: Event[],
): void {
  // Replay plans, reassessments, and change transitions in one chronological
  // pass: later epochs are only admissible after their unsatisfied
  // reassessment, exactly as they were recorded live.
  for (const event of events) {
    const type = event.data.runtimeEventType;
    if (type === "supervisor.change_plan") {
      const changePlan = event.data.changePlan;
      if (!Array.isArray(changePlan) || changePlan.length === 0) continue;
      if (!changeRegistry.hasPlan()) {
        changeRegistry.registerPlan(changePlan as ManagedChangePlanEntry[]);
      } else {
        changeRegistry.registerNextEpoch(changePlan as ManagedChangePlanEntry[]);
      }
      continue;
    }
    if (type === "supervisor.reassessment") {
      changeRegistry.recordReassessment({
        goalSatisfied: event.data.goalSatisfied === true,
        evidence: replayedStringList(event.data.evidence),
        remainingGaps: replayedStringList(event.data.remainingGaps),
        nextEpochRationale:
          typeof event.data.nextEpochRationale === "string" ? event.data.nextEpochRationale : null,
      });
      continue;
    }
    const eventTaskId = event.data.taskId;
    const changeId = typeof event.data.changeId === "string"
      ? event.data.changeId
      : type === "managed_task.attempt_started" && typeof eventTaskId === "string" && eventTaskId.startsWith("spec:")
        ? eventTaskId.slice("spec:".length)
        : undefined;
    if (typeof changeId !== "string" || changeId.length === 0) continue;
    const workerDelegationRequestId = event.data.workerDelegationRequestId;
    const summary = event.data.summary;
    if (
      type === "managed_task.attempt_started" &&
      eventTaskId === specTaskId(changeId) &&
      typeof workerDelegationRequestId === "string" &&
      workerDelegationRequestId.trim().length > 0
    ) {
      changeRegistry.markSpecAttemptStarted(changeId, workerDelegationRequestId);
    } else if (
      type === "change.spec_review_requested" &&
      typeof workerDelegationRequestId === "string" &&
      workerDelegationRequestId.length > 0
    ) {
      changeRegistry.markSpecReadyForReview(changeId, workerDelegationRequestId);
    } else if (
      (type === "change.spec_supervisor_approved" || type === "change.spec_supervisor_rejected") &&
      typeof workerDelegationRequestId === "string" &&
      workerDelegationRequestId.length > 0 &&
      typeof summary === "string" &&
      summary.trim().length > 0
    ) {
      changeRegistry.recordSpecReview({
        changeId,
        workerDelegationRequestId,
        decision: type === "change.spec_supervisor_approved" ? "approve" : "reject",
        summary,
      });
    } else if (
      type === "change.spec_merged" &&
      typeof workerDelegationRequestId === "string" &&
      workerDelegationRequestId.trim().length > 0 &&
      changeRegistry.gateSpecReviewMerge(changeId, workerDelegationRequestId).ok
    ) {
      changeRegistry.markSpecMerged(changeId);
    } else if (type === "change.spec_approved") {
      // Legacy pre-gate event name: replayed ungated as a historical fact.
      changeRegistry.markSpecMerged(changeId);
    } else if (type === "change.archived") changeRegistry.markArchived(changeId);
    else if (type === "change.blocked") changeRegistry.markBlocked(changeId);
  }
  if (!changeRegistry.hasPlan()) return;

  // Re-link tasks to their change from the durable task rows.
  for (const task of managedTaskRepo.listForGoal(goalId)) {
    if (task.changeId) changeRegistry.registerTask(task.changeId, task.id);
  }
}

function replayedStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function toTaskStatus(status: ManagedTaskStatus): TaskStatus {
  switch (status) {
    case "accepted":
      return "done";
    case "split":
      return "split";
    case "failed":
    case "blocked":
      return "failed";
    case "delegated":
    case "awaiting_review":
    case "awaiting_delivery":
      return "delegated";
    default:
      return "pending";
  }
}

function toCriterionOutcome(outcome: string): CriterionOutcome {
  if (outcome === "PASS") return "passed";
  if (outcome === "FAIL") return "failed";
  return "unknown";
}
