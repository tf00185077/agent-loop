import type {
  GoalReassessment,
  ManagedChangePlanEntry,
  ManagedChangeStatus,
  TaskAcceptanceCriterion,
} from "../../domain/index.js";
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
  /** Planning epoch this change belongs to (1-based). */
  epochSequence: number;
}

export interface EpochRecord {
  sequence: number;
  /** Reassessment rationale that admitted this epoch; null for epoch 1. */
  rationale: string | null;
  changeIds: string[];
}

export interface ReassessmentRecord extends GoalReassessment {
  /** Epoch the judgment concluded (the goal's epoch count at record time). */
  epochSequence: number;
}

export type RegistryGate = { ok: true } | { ok: false; safeReason: string };

export type ChangeIdResolution =
  | { ok: true; changeId: string | null }
  | { ok: false; safeReason: string };

export function specTaskId(changeId: string): string {
  return `spec:${changeId}`;
}

/**
 * Map OpenSpec validation failures onto the frozen S1–S3 criteria and render
 * a verdict text that cites them, so the standard substantive-rejection
 * machinery (criterion citation, retry budgets, narrowing) applies unchanged.
 */
export function specValidationVerdict(failures: string[]): string {
  return failures
    .map((failure) => {
      const criterion = /WHEN\/THEN/i.test(failure)
        ? "S2"
        : /acceptance/i.test(failure) || /no tasks/i.test(failure)
          ? "S3"
          : "S1";
      return `${criterion} fails: ${failure}`;
    })
    .join(" ");
}

/**
 * Backend-authored acceptance contract for spec-writer tasks. Frozen at plan
 * acceptance; supervisors cannot replace it (the task registry ignores
 * criteria mutations on contracted tasks).
 */
export function specTaskAcceptance(changeId: string): TaskAcceptanceCriterion[] {
  return [
    {
      id: "S1",
      text: `OpenSpec validation passes for change ${changeId} (strict CLI validate or the degraded structural checks).`,
    },
    { id: "S2", text: "Every requirement in the change's specs has at least one WHEN/THEN scenario." },
    { id: "S3", text: "Every task in the change's tasks.md carries acceptance criteria." },
  ];
}

/**
 * Per-goal change-plan working state. One plan per planning epoch; later
 * epochs are admitted only through an unsatisfied goal reassessment. Exactly
 * one active change at a time in dependency-then-plan order across epochs.
 * Every transition it gates is also persisted as durable events by the caller.
 */
export class GoalChangeRegistry {
  private plan: ChangeRecord[] | null = null;
  private epochs: EpochRecord[] = [];
  private reassessments: ReassessmentRecord[] = [];

  registerPlan(changes: ManagedChangePlanEntry[]): RegistryGate {
    if (this.plan) {
      return { ok: false, safeReason: "A change plan already exists for this goal." };
    }
    this.plan = this.buildEpochChanges(changes, 1);
    this.epochs.push({ sequence: 1, rationale: null, changeIds: this.plan.map((change) => change.id) });
    const first = this.plan[0];
    if (first) first.status = "specifying";
    return { ok: true };
  }

  /**
   * Open the next planning epoch. Deterministic gate for AC3: unreachable
   * without a recorded unsatisfied reassessment that no epoch consumed yet.
   */
  registerNextEpoch(changes: ManagedChangePlanEntry[]): RegistryGate {
    if (!this.plan) {
      return { ok: false, safeReason: "No change plan exists; announce the first plan instead." };
    }
    if (!this.pendingNextEpoch()) {
      return {
        ok: false,
        safeReason:
          "A next epoch requires an unsatisfied goal reassessment first. " +
          "Emit managed_goal.reassessment after all changes archive.",
      };
    }
    const existing = new Set(this.plan.map((change) => change.id));
    const collisions = changes.map((change) => change.id).filter((id) => existing.has(id));
    if (collisions.length > 0) {
      return {
        ok: false,
        safeReason: `Change ids must be unique across epochs; already used: ${collisions.join(", ")}.`,
      };
    }
    const sequence = this.epochCount() + 1;
    const batch = this.buildEpochChanges(changes, sequence);
    this.plan.push(...batch);
    this.epochs.push({
      sequence,
      rationale: this.latestReassessment()?.nextEpochRationale ?? null,
      changeIds: batch.map((change) => change.id),
    });
    const active = this.activeChange();
    if (active && active.status === "planned") active.status = "specifying";
    return { ok: true };
  }

  /** Record a goal-level judgment; gated on a plan with every change archived. */
  recordReassessment(reassessment: GoalReassessment): RegistryGate {
    if (!this.plan) {
      return { ok: false, safeReason: "Goal has no change plan; reassessment applies to planned goals only." };
    }
    const unarchived = this.unarchivedIds();
    if (unarchived.length > 0) {
      return {
        ok: false,
        safeReason: `Reassessment requires every change archived first; unarchived: ${unarchived.join(", ")}.`,
      };
    }
    this.reassessments.push({ ...reassessment, epochSequence: this.epochCount() });
    return { ok: true };
  }

  latestReassessment(): ReassessmentRecord | null {
    return this.reassessments.at(-1) ?? null;
  }

  /** True when the latest reassessment found gaps and no epoch consumed it yet. */
  pendingNextEpoch(): boolean {
    const latest = this.latestReassessment();
    return latest !== null && !latest.goalSatisfied && latest.epochSequence === this.epochCount();
  }

  listEpochs(): EpochRecord[] {
    return this.epochs.map((epoch) => ({ ...epoch, changeIds: [...epoch.changeIds] }));
  }

  epochCount(): number {
    return this.epochs.length;
  }

  private buildEpochChanges(changes: ManagedChangePlanEntry[], epochSequence: number): ChangeRecord[] {
    return orderByDependencies(changes).map((change) => ({
      id: change.id,
      title: change.title,
      rationale: change.rationale,
      dependsOn: change.dependsOn ?? [],
      status: "planned",
      taskIds: [specTaskId(change.id)],
      hasUnmergedAttestedChanges: false,
      epochSequence,
    }));
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
