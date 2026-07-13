import type { ManagedChangePlanEntry, ManagedChangeStatus } from "../../domain/index.js";
import type { GoalTaskRegistry } from "./task-registry.js";

export interface ChangeRecord {
  id: string;
  title: string;
  rationale: string;
  dependsOn: string[];
  status: ManagedChangeStatus;
  /** Task ids registered under this change (includes the spec task). */
  taskIds: string[];
  /** Whether any worker under this change produced attested file changes. */
  hasUnmergedAttestedChanges: boolean;
}

export type RegistryGate = { ok: true } | { ok: false; safeReason: string };

export type ChangeIdResolution =
  | { ok: true; changeId: string | null }
  | { ok: false; safeReason: string };

export function specTaskId(changeId: string): string {
  return `spec:${changeId}`;
}

/**
 * Per-goal change-plan working state. One plan per goal; exactly one active
 * change at a time in dependency-then-plan order. Every transition it gates
 * is also persisted as durable events by the caller.
 */
export class GoalChangeRegistry {
  private plan: ChangeRecord[] | null = null;

  registerPlan(changes: ManagedChangePlanEntry[]): RegistryGate {
    if (this.plan) {
      return { ok: false, safeReason: "A change plan already exists for this goal." };
    }
    this.plan = orderByDependencies(changes).map((change) => ({
      id: change.id,
      title: change.title,
      rationale: change.rationale,
      dependsOn: change.dependsOn ?? [],
      status: "planned",
      taskIds: [specTaskId(change.id)],
      hasUnmergedAttestedChanges: false,
    }));
    const first = this.plan[0];
    if (first) first.status = "specifying";
    return { ok: true };
  }

  hasPlan(): boolean {
    return this.plan !== null;
  }

  listChanges(): ChangeRecord[] {
    return this.plan ? [...this.plan] : [];
  }

  getChange(changeId: string): ChangeRecord | undefined {
    return this.plan?.find((change) => change.id === changeId);
  }

  activeChange(): ChangeRecord | null {
    return this.plan?.find((change) => change.status !== "archived" && change.status !== "blocked") ?? null;
  }

  /**
   * Resolve the change a task list or delegation belongs to: inherit the
   * active change when unspecified, reject explicit mismatches.
   */
  resolveChangeId(explicit: string | null): ChangeIdResolution {
    if (!this.plan) {
      return { ok: true, changeId: null };
    }
    const active = this.activeChange();
    if (!active) {
      return { ok: false, safeReason: "All planned changes are archived; no change accepts new work." };
    }
    if (explicit && explicit !== active.id) {
      return {
        ok: false,
        safeReason: `Change ${explicit} is not active. Work on the active change ${active.id} first.`,
      };
    }
    return { ok: true, changeId: active.id };
  }

  registerTask(changeId: string, taskId: string): void {
    const change = this.getChange(changeId);
    if (change && !change.taskIds.includes(taskId)) {
      change.taskIds.push(taskId);
    }
  }

  markSpecApproved(changeId: string): void {
    const change = this.getChange(changeId);
    if (change && change.status === "specifying") {
      change.status = "executing";
    }
  }

  recordAttestedWorkerChanges(changeId: string): void {
    const change = this.getChange(changeId);
    if (change) change.hasUnmergedAttestedChanges = true;
  }

  recordMerged(changeId: string): void {
    const change = this.getChange(changeId);
    if (change) change.hasUnmergedAttestedChanges = false;
  }

  /**
   * A change may archive when all of its registered tasks are done (split
   * tasks count through their descendants) and no attested worker changes
   * remain unmerged.
   */
  canArchive(changeId: string, tasks: GoalTaskRegistry): RegistryGate {
    const change = this.getChange(changeId);
    if (!change) {
      return { ok: false, safeReason: `Unknown change: ${changeId}` };
    }
    const undone = change.taskIds.filter((taskId) => !isTaskDelivered(taskId, tasks));
    if (undone.length > 0) {
      return { ok: false, safeReason: `Change ${changeId} has undelivered tasks: ${undone.join(", ")}` };
    }
    if (change.hasUnmergedAttestedChanges) {
      return {
        ok: false,
        safeReason: `Change ${changeId} has attested worker file changes that were never review-merged.`,
      };
    }
    return { ok: true };
  }

  markArchived(changeId: string): void {
    const change = this.getChange(changeId);
    if (!change) return;
    change.status = "archived";
    const next = this.activeChange();
    if (next && next.status === "planned") {
      next.status = "specifying";
    }
  }

  markBlocked(changeId: string): void {
    const change = this.getChange(changeId);
    if (change) change.status = "blocked";
  }

  findChangeByTask(taskId: string): ChangeRecord | undefined {
    return this.plan?.find((change) => change.taskIds.includes(taskId));
  }

  allArchived(): boolean {
    return this.plan !== null && this.plan.every((change) => change.status === "archived");
  }

  unarchivedIds(): string[] {
    return (this.plan ?? []).filter((change) => change.status !== "archived").map((change) => change.id);
  }
}

function isTaskDelivered(taskId: string, tasks: GoalTaskRegistry): boolean {
  const task = tasks.getTask(taskId);
  if (!task) return false;
  if (task.status === "done") return true;
  if (task.status === "split") {
    const descendants = tasks.listTasks().filter((candidate) => candidate.parentTaskId === taskId);
    return descendants.length > 0 && descendants.every((descendant) => isTaskDelivered(descendant.id, tasks));
  }
  return false;
}

/** Stable topological order: dependencies first, plan order as tiebreak. */
function orderByDependencies(changes: ManagedChangePlanEntry[]): ManagedChangePlanEntry[] {
  const remaining = [...changes];
  const ordered: ManagedChangePlanEntry[] = [];
  const placed = new Set<string>();
  while (remaining.length > 0) {
    const index = remaining.findIndex((change) => (change.dependsOn ?? []).every((dep) => placed.has(dep)));
    // Validation guarantees acyclic dependencies, so index is always >= 0.
    const [next] = remaining.splice(index === -1 ? 0 : index, 1);
    ordered.push(next!);
    placed.add(next!.id);
  }
  return ordered;
}
