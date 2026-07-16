import type {
  AgentRuntimeDelegationSummary,
  ManagedTaskListEntry,
  TaskAcceptanceCriterion,
} from "../../domain/index.js";

export type TaskStatus = "pending" | "delegated" | "done" | "failed" | "split";

export type CriterionOutcome = "unknown" | "passed" | "failed";

export interface TaskRecord {
  id: string;
  title: string;
  acceptance: TaskAcceptanceCriterion[] | null;
  status: TaskStatus;
  /** Delegation attempts started for this task. */
  attemptCount: number;
  /** Rejections that cited at least one frozen criterion id. */
  substantiveRejections: number;
  /** Criterion ids cited by the most recent substantive rejection. */
  lastCitedCriteria: string[];
  criterionOutcomes: Record<string, CriterionOutcome>;
  parentTaskId: string | null;
  lastOutcomeSummary: string | null;
}

export interface RegisterTaskListResult {
  tasks: TaskRecord[];
  /** Task ids whose frozen criteria a later announcement tried to change. */
  ignoredMutations: string[];
}

export type DelegationGateResult =
  | { ok: true; acceptance: TaskAcceptanceCriterion[] | null; uncontracted: boolean }
  | { ok: false; safeReason: string };

export interface VerdictClassification {
  substantive: boolean;
  citedCriteria: string[];
  deferredFinding: string | null;
}

const MAX_TASK_ATTEMPTS = 3;
const NARROWING_REJECTION_THRESHOLD = 2;

/**
 * Per-goal registry of announced tasks and their frozen acceptance contracts.
 * In-memory working state; every transition it gates is also persisted as
 * durable events/rows by the caller.
 */
export class GoalTaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>();

  registerTaskList(entries: ManagedTaskListEntry[]): RegisterTaskListResult {
    const result: RegisterTaskListResult = { tasks: [], ignoredMutations: [] };
    for (const entry of entries) {
      const existing = this.tasks.get(entry.id);
      if (!existing) {
        const record: TaskRecord = {
          id: entry.id,
          title: entry.title,
          acceptance: entry.acceptance ?? null,
          status: "pending",
          attemptCount: 0,
          substantiveRejections: 0,
          lastCitedCriteria: [],
          criterionOutcomes: Object.fromEntries(
            (entry.acceptance ?? []).map((criterion) => [criterion.id, "unknown" as CriterionOutcome]),
          ),
          parentTaskId: findParent(this.tasks, entry),
          lastOutcomeSummary: null,
        };
        this.tasks.set(entry.id, record);
        result.tasks.push(record);
        continue;
      }
      // Frozen criteria: a later announcement can add criteria to a task that
      // had none, but cannot change an existing contract.
      if (!existing.acceptance && entry.acceptance) {
        existing.acceptance = entry.acceptance;
        existing.criterionOutcomes = Object.fromEntries(
          entry.acceptance.map((criterion) => [criterion.id, "unknown" as CriterionOutcome]),
        );
      } else if (existing.acceptance && entry.acceptance && !sameCriteria(existing.acceptance, entry.acceptance)) {
        result.ignoredMutations.push(entry.id);
      }
      result.tasks.push(existing);
    }
    return result;
  }

  /**
   * Replace the in-memory task state with records reconstructed from durable
   * rows (restart recovery / resume). The durable ledger is authoritative; this
   * repopulates the working cache so gating and history reflect it.
   */
  hydrate(records: TaskRecord[]): void {
    this.tasks.clear();
    for (const record of records) {
      this.tasks.set(record.id, { ...record, criterionOutcomes: { ...record.criterionOutcomes } });
    }
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  /**
   * Gate a worker delegation. Applies the missing-contract rule, freezes
   * first-use criteria, counts attempts, and enforces the narrowing rule.
   */
  gateWorkerDelegation(
    taskId: string | null,
    requestAcceptance: TaskAcceptanceCriterion[] | null,
  ): DelegationGateResult {
    if (!taskId) {
      return { ok: true, acceptance: requestAcceptance, uncontracted: true };
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      // Unknown task id: treat like an ad-hoc delegation but keep the id.
      return { ok: true, acceptance: requestAcceptance, uncontracted: true };
    }

    if (!task.acceptance && requestAcceptance) {
      // First delegation may announce the contract; it freezes here.
      task.acceptance = requestAcceptance;
      task.criterionOutcomes = Object.fromEntries(
        requestAcceptance.map((criterion) => [criterion.id, "unknown" as CriterionOutcome]),
      );
    }
    if (!task.acceptance) {
      return {
        ok: false,
        safeReason: `Task ${taskId} has no acceptance contract. Announce acceptance criteria for it before delegating.`,
      };
    }

    if (task.status === "split") {
      return {
        ok: false,
        safeReason: `Task ${taskId} was split into narrower tasks. Delegate the narrower tasks instead.`,
      };
    }

    const narrowingDue =
      task.substantiveRejections >= NARROWING_REJECTION_THRESHOLD ||
      task.attemptCount >= MAX_TASK_ATTEMPTS;
    if (narrowingDue) {
      const failing =
        task.lastCitedCriteria.length > 0 ? task.lastCitedCriteria.join(", ") : "the unmet criteria";
      task.status = "split";
      return {
        ok: false,
        safeReason:
          `Task ${taskId} reached its retry budget (${task.substantiveRejections} substantive rejections, ` +
          `${task.attemptCount} attempts). Do not retry the same scope. Split the failing criteria (${failing}) ` +
          `into strictly narrower tasks with fewer criteria and a parentTaskId of ${taskId}, or mark the task failed and re-plan.`,
      };
    }

    task.attemptCount += 1;
    task.status = "delegated";
    return { ok: true, acceptance: task.acceptance, uncontracted: false };
  }

  /**
   * Classify verdict text against a task's frozen criteria. Cited criteria
   * make the verdict substantive; otherwise it is a deferred finding.
   */
  classifyVerdict(taskId: string, verdictText: string): VerdictClassification {
    const task = this.tasks.get(taskId);
    if (!task?.acceptance) {
      return { substantive: false, citedCriteria: [], deferredFinding: verdictText };
    }
    const cited = task.acceptance
      .map((criterion) => criterion.id)
      .filter((id) => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(id)}(?:$|[^A-Za-z0-9])`).test(verdictText));
    if (cited.length === 0) {
      return { substantive: false, citedCriteria: [], deferredFinding: verdictText };
    }
    task.substantiveRejections += 1;
    task.lastCitedCriteria = cited;
    for (const id of cited) {
      task.criterionOutcomes[id] = "failed";
    }
    return { substantive: true, citedCriteria: cited, deferredFinding: null };
  }

  recordOutcome(taskId: string, summary: AgentRuntimeDelegationSummary): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.lastOutcomeSummary = summary.safeSummary;
    if (summary.kind === "success") {
      for (const evidence of summary.criterionEvidence ?? []) {
        if (task.criterionOutcomes[evidence.criterionId] !== undefined) {
          task.criterionOutcomes[evidence.criterionId] = "passed";
        }
      }
      task.status = "done";
      return;
    }
    if (task.status !== "split") {
      task.status = "pending";
    }
  }

  markFailed(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.status = "failed";
  }
}

function sameCriteria(a: TaskAcceptanceCriterion[], b: TaskAcceptanceCriterion[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((criterion) => [criterion.id, criterion.text]));
  return b.every((criterion) => byId.get(criterion.id) === criterion.text);
}

function findParent(tasks: Map<string, TaskRecord>, entry: ManagedTaskListEntry): string | null {
  const parentId = entry.parentTaskId ?? null;
  if (!parentId) return null;
  return tasks.has(parentId) ? parentId : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
