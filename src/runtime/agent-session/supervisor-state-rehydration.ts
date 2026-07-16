import type { Event, ManagedChangePlanEntry, ManagedTaskStatus } from "../../domain/index.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { GoalChangeRegistry } from "./change-registry.js";
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
  const planEvent = events.find((event) => event.data.runtimeEventType === "supervisor.change_plan");
  const changePlan = planEvent?.data.changePlan;
  if (!Array.isArray(changePlan) || changePlan.length === 0) return;

  const gate = changeRegistry.registerPlan(changePlan as ManagedChangePlanEntry[]);
  if (!gate.ok) return;

  // Re-link tasks to their change from the durable task rows.
  for (const task of managedTaskRepo.listForGoal(goalId)) {
    if (task.changeId) changeRegistry.registerTask(task.changeId, task.id);
  }

  // Replay the durable change transition events in chronological order.
  for (const event of events) {
    const type = event.data.runtimeEventType;
    const changeId = event.data.changeId;
    if (typeof changeId !== "string") continue;
    if (type === "change.spec_approved") changeRegistry.markSpecApproved(changeId);
    else if (type === "change.archived") changeRegistry.markArchived(changeId);
    else if (type === "change.blocked") changeRegistry.markBlocked(changeId);
  }
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
