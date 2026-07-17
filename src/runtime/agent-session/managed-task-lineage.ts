import type { ManagedCompletionGap, ManagedTaskListEntry } from "../../domain/index.js";
import type { AppDatabase } from "../../persistence/database.js";

const MAX_DIAGNOSTIC_TASK_IDS = 20;

export interface NarrowingTaskSnapshot {
  id: string;
  goalId: string | null;
  changeId: string | null;
  parentTaskId: string | null;
  status: string;
  attemptCount: number;
  substantiveRejectionCount: number;
  acceptance: Array<{ id: string; text: string }> | null;
  pipelineActive?: boolean;
}

export interface NarrowingRegistrationPlan {
  splitParentIds: string[];
  idempotentTaskIds: string[];
}

export class ManagedLineageValidationError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly taskIds: string[],
  ) {
    super(message);
    this.name = "ManagedLineageValidationError";
  }
}

/**
 * Validate one complete task-list announcement without mutating its source.
 * Child groups are deliberately evaluated against the pre-announcement graph:
 * a task cannot create its own parent or extend a previously frozen split.
 */
export function planNarrowingRegistration(input: {
  existing: NarrowingTaskSnapshot[];
  entries: ManagedTaskListEntry[];
  goalId: string | null;
  changeId: string | null;
}): NarrowingRegistrationPlan {
  const existingById = new Map(input.existing.map((task) => [task.id, task]));
  const entryIds = new Set<string>();
  for (const entry of input.entries) {
    if (entryIds.has(entry.id)) {
      throw lineageError("duplicate_child_id", `Task list contains duplicate logical task id ${entry.id}.`, [entry.id]);
    }
    entryIds.add(entry.id);
  }

  const childGroups = new Map<string, ManagedTaskListEntry[]>();
  for (const entry of input.entries) {
    if (!entry.parentTaskId) continue;
    if (entry.id === entry.parentTaskId) {
      throw lineageError("self_parent", `Managed task ${entry.id} cannot parent itself.`, [entry.id]);
    }
    const group = childGroups.get(entry.parentTaskId) ?? [];
    group.push(entry);
    childGroups.set(entry.parentTaskId, group);
  }

  const splitParentIds: string[] = [];
  const idempotentTaskIds: string[] = [];
  for (const [parentId, submittedChildren] of childGroups) {
    const parent = existingById.get(parentId);
    if (!parent) {
      throw lineageError("missing_parent", `Managed parent task not found: ${parentId}.`, [parentId]);
    }
    if (parent.goalId !== input.goalId) {
      throw lineageError("cross_goal", `Managed parent task ${parentId} belongs to another Goal.`, [parentId]);
    }
    if (parent.changeId !== input.changeId) {
      throw lineageError("cross_change", `Managed parent task ${parentId} belongs to another change.`, [parentId]);
    }

    const existingChildren = input.existing.filter((task) => task.parentTaskId === parentId);
    if (parent.status === "split" && existingChildren.length > 0) {
      const frozenIds = existingChildren.map((task) => task.id).sort();
      const submittedIds = submittedChildren.map((task) => task.id).sort();
      if (!sameStrings(frozenIds, submittedIds)) {
        throw lineageError(
          "frozen_child_set",
          `Managed split ${parentId} has a frozen child set and cannot add, remove, or replace descendants.`,
          [parentId, ...frozenIds, ...submittedIds],
        );
      }
      for (const entry of submittedChildren) {
        const child = existingById.get(entry.id);
        if (!child || child.parentTaskId !== parentId || child.goalId !== input.goalId || child.changeId !== input.changeId
          || !sameCriteria(child.acceptance, entry.acceptance ?? null)) {
          throw lineageError(
            "frozen_child_contract",
            `Managed split ${parentId} child contracts are frozen.`,
            [parentId, entry.id],
          );
        }
        idempotentTaskIds.push(entry.id);
      }
      continue;
    }

    if (existingChildren.length > 0) {
      throw lineageError(
        "parent_not_split",
        `Managed task ${parentId} already has descendants without a frozen split transition.`,
        [parentId, ...existingChildren.map((task) => task.id)],
      );
    }
    const thresholdReached = parent.substantiveRejectionCount >= 2 || parent.attemptCount >= 3;
    if (parent.status !== "split" && !thresholdReached) {
      throw lineageError(
        "retry_threshold_not_reached",
        `Managed parent task ${parentId} has not reached its retry threshold.`,
        [parentId],
      );
    }
    if (["accepted", "done"].includes(parent.status)) {
      throw lineageError("terminal_parent", `Managed parent task ${parentId} is already accepted.`, [parentId]);
    }
    if (parent.pipelineActive || ["delegated", "awaiting_review", "awaiting_delivery"].includes(parent.status)) {
      throw lineageError(
        "active_parent_pipeline",
        `Managed parent task ${parentId} has active or pending pipeline work.`,
        [parentId],
      );
    }
    const parentCriterionCount = parent.acceptance?.length ?? 0;
    for (const entry of submittedChildren) {
      const existing = existingById.get(entry.id);
      if (existing) {
        throw lineageError("duplicate_child_id", `Managed child task already exists: ${entry.id}.`, [parentId, entry.id]);
      }
      const acceptance = entry.acceptance ?? [];
      if (acceptance.length === 0) {
        throw lineageError(
          "empty_child_contract",
          `Managed child task ${entry.id} requires a non-empty acceptance contract.`,
          [parentId, entry.id],
        );
      }
      if (parentCriterionCount === 0 || acceptance.length >= parentCriterionCount) {
        throw lineageError(
          "child_contract_not_narrower",
          `Managed child task ${entry.id} must have a strictly narrower acceptance contract than ${parentId}.`,
          [parentId, entry.id],
        );
      }
      const criterionIds = new Set<string>();
      for (const criterion of acceptance) {
        if (!criterion.id.trim() || !criterion.text.trim() || criterionIds.has(criterion.id)) {
          throw lineageError(
            "invalid_child_contract",
            `Managed child task ${entry.id} has an invalid or duplicate acceptance criterion.`,
            [parentId, entry.id],
          );
        }
        criterionIds.add(criterion.id);
      }
    }
    splitParentIds.push(parentId);
  }

  return {
    splitParentIds: uniqueBounded(splitParentIds),
    idempotentTaskIds: uniqueBounded(idempotentTaskIds),
  };
}

export interface DurableLineageTask {
  databaseId: string;
  id: string;
  goalId: string;
  changeId: string | null;
  parentDatabaseId: string | null;
  parentTaskId: string | null;
  parentGoalId: string | null;
  parentChangeId: string | null;
  status: string;
  criterionCount: number;
}

export interface DurableLineageProjection {
  tasks: DurableLineageTask[];
  leafTaskIds: string[];
  gaps: ManagedCompletionGap[];
  frozenContractAmbiguousTaskIds: string[];
  frozenContractAmbiguityIsGlobal: boolean;
}

export interface ManagedTaskMigrationAmbiguities {
  frozenContractTaskIds: string[];
  frozenContractAmbiguityIsGlobal: boolean;
  splitLineageTaskIds: string[];
  splitLineageMarkerPresent: boolean;
}

/** Structural compatibility projection for installations without a durable repository. */
export function evaluateTaskSnapshotLineage(
  tasks: Array<{ id: string; parentTaskId: string | null; status: string }>,
): ManagedCompletionGap[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    if (!byId.has(task.parentTaskId)) {
      return [{
        type: "invalid_split_lineage", reasonCode: "missing_parent", taskId: task.id,
        taskIds: [task.id], safeSummary: `Managed task ${task.id} references a missing parent (missing_parent).`,
      }];
    }
    const group = children.get(task.parentTaskId) ?? [];
    group.push(task.id);
    children.set(task.parentTaskId, group);
  }
  for (const task of tasks) {
    const descendants = children.get(task.id) ?? [];
    if (descendants.length > 0 && task.status !== "split") {
      return [{
        type: "invalid_split_lineage", reasonCode: "parent_not_split", taskId: task.id,
        taskIds: uniqueBounded([task.id, ...descendants]),
        safeSummary: `Managed task ${task.id} has descendants but is not split (parent_not_split).`,
      }];
    }
    if (task.status === "split" && descendants.length === 0) {
      return [{
        type: "invalid_split_lineage", reasonCode: "split_without_children", taskId: task.id,
        taskIds: [task.id], safeSummary: `Managed task ${task.id} is split without children (split_without_children).`,
      }];
    }
  }
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (seen.has(id)) return false;
    visiting.add(id);
    const parentId = byId.get(id)?.parentTaskId;
    if (parentId && visit(parentId)) return true;
    visiting.delete(id);
    seen.add(id);
    return false;
  };
  for (const task of tasks) {
    if (visit(task.id)) {
      return [{
        type: "invalid_split_lineage", reasonCode: "cycle", taskId: task.id,
        taskIds: [task.id], safeSummary: `Managed task lineage contains a cycle at ${task.id} (cycle).`,
      }];
    }
  }
  return [];
}

/** One Goal-scoped structural projection used by completion and archive gates. */
export function evaluateDurableManagedTaskLineage(
  db: AppDatabase,
  goalId: string,
): DurableLineageProjection {
  const rows = db.prepare(`
    SELECT t.id AS database_id, t.logical_task_id, t.goal_id, t.change_id,
      t.parent_task_id, t.status,
      p.logical_task_id AS parent_logical_task_id,
      p.goal_id AS parent_goal_id, p.change_id AS parent_change_id,
      (SELECT COUNT(*) FROM managed_task_criteria c WHERE c.task_id = t.id) AS criterion_count
    FROM managed_tasks t
    LEFT JOIN managed_tasks p ON p.id = t.parent_task_id
    WHERE t.goal_id = ?
    ORDER BY t.created_at, t.rowid
  `).all(goalId) as Array<Record<string, string | number | null>>;
  const tasks: DurableLineageTask[] = rows.map((row) => ({
    databaseId: row.database_id as string,
    id: row.logical_task_id as string,
    goalId: row.goal_id as string,
    changeId: row.change_id as string | null,
    parentDatabaseId: row.parent_task_id as string | null,
    parentTaskId: row.parent_logical_task_id as string | null,
    parentGoalId: row.parent_goal_id as string | null,
    parentChangeId: row.parent_change_id as string | null,
    status: row.status as string,
    criterionCount: row.criterion_count as number,
  }));
  const byDatabaseId = new Map(tasks.map((task) => [task.databaseId, task]));
  const children = new Map<string, DurableLineageTask[]>();
  for (const task of tasks) {
    if (!task.parentDatabaseId || !byDatabaseId.has(task.parentDatabaseId)) continue;
    const group = children.get(task.parentDatabaseId) ?? [];
    group.push(task);
    children.set(task.parentDatabaseId, group);
  }

  const diagnostics = new Map<string, ManagedCompletionGap>();
  const addGap = (reasonCode: string, taskIds: string[], summary: string) => {
    const bounded = uniqueBounded(taskIds);
    const key = `${reasonCode}:${bounded.join(",")}`;
    if (diagnostics.has(key)) return;
    diagnostics.set(key, {
      type: "invalid_split_lineage",
      reasonCode,
      taskId: taskIds[0] ?? null,
      taskIds: bounded,
      safeSummary: summary,
    });
  };

  for (const task of tasks) {
    if (task.parentDatabaseId) {
      if (task.parentTaskId && task.parentGoalId !== goalId) {
        addGap(
          "cross_goal",
          [task.id, task.parentTaskId],
          `Managed task ${task.id} has a parent in another Goal (cross_goal).`,
        );
      } else if (!task.parentTaskId) {
        const parent = db.prepare("SELECT goal_id, logical_task_id FROM managed_tasks WHERE id = ?")
          .get(task.parentDatabaseId) as { goal_id: string; logical_task_id: string } | undefined;
        if (parent && parent.goal_id !== goalId) {
          addGap(
            "cross_goal",
            [task.id, parent.logical_task_id],
            `Managed task ${task.id} has a parent in another Goal (cross_goal).`,
          );
        } else {
          addGap("missing_parent", [task.id], `Managed task ${task.id} references a missing parent (missing_parent).`);
        }
      } else if (task.parentChangeId !== task.changeId) {
        addGap(
          "cross_change",
          [task.parentTaskId, task.id],
          `Managed task ${task.id} and parent ${task.parentTaskId} belong to different changes (cross_change).`,
        );
      }
    }
    const descendants = children.get(task.databaseId) ?? [];
    if (descendants.length > 0 && task.status !== "split") {
      addGap(
        "parent_not_split",
        [task.id, ...descendants.map((child) => child.id)],
        `Managed task ${task.id} has descendants but is not split (parent_not_split).`,
      );
    }
    if (task.status === "split" && descendants.length === 0) {
      addGap("split_without_children", [task.id], `Managed task ${task.id} is split without children (split_without_children).`);
    }
    for (const child of descendants) {
      if (child.criterionCount === 0 || task.criterionCount === 0 || child.criterionCount >= task.criterionCount) {
        addGap(
          "child_contract_not_narrower",
          [task.id, child.id],
          `Managed child ${child.id} is not contractually narrower than ${task.id} (child_contract_not_narrower).`,
        );
      }
    }
  }

  const frozenSplitEvidence = loadFrozenSplitEvidence(db, goalId);
  for (const task of tasks) {
    if (task.status !== "split") continue;
    const actualChildIds = (children.get(task.databaseId) ?? []).map((child) => child.id).sort();
    const evidenceSets = frozenSplitEvidence.get(task.id) ?? [];
    if (evidenceSets.length === 0) {
      addGap(
        "missing_split_evidence",
        [task.id, ...actualChildIds],
        `Managed split ${task.id} has no durable frozen child evidence (missing_split_evidence).`,
      );
      continue;
    }
    if (evidenceSets.length > 1) {
      addGap(
        "ambiguous_split_evidence",
        [task.id, ...actualChildIds, ...evidenceSets.flat()],
        `Managed split ${task.id} has conflicting durable child evidence (ambiguous_split_evidence).`,
      );
      continue;
    }
    if (!sameStrings(evidenceSets[0]!, actualChildIds)) {
      addGap(
        "frozen_child_set_mismatch",
        [task.id, ...evidenceSets[0]!, ...actualChildIds],
        `Managed split ${task.id} descendants do not match its frozen child evidence (frozen_child_set_mismatch).`,
      );
    }
  }

  const migrationAmbiguities = loadManagedTaskMigrationAmbiguities(db, goalId);
  if (migrationAmbiguities.frozenContractAmbiguityIsGlobal) {
    addGap(
      "ambiguous_frozen_contract",
      [],
      "Frozen acceptance contract migration diagnostics were truncated without complete enforcement identity (ambiguous_frozen_contract).",
    );
  } else {
    for (const taskId of migrationAmbiguities.frozenContractTaskIds.slice(0, MAX_DIAGNOSTIC_TASK_IDS)) {
      addGap(
        "ambiguous_frozen_contract",
        [taskId],
        `Managed task ${taskId} has an ambiguous frozen acceptance contract (ambiguous_frozen_contract).`,
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: DurableLineageTask[] = [];
  const visit = (task: DurableLineageTask) => {
    if (visited.has(task.databaseId)) return;
    if (visiting.has(task.databaseId)) {
      const cycleStart = stack.findIndex((candidate) => candidate.databaseId === task.databaseId);
      const cycle = stack.slice(Math.max(0, cycleStart)).map((candidate) => candidate.id);
      addGap("cycle", [...cycle, task.id], `Managed task lineage contains a cycle (${uniqueBounded(cycle).join(", ")}) (cycle).`);
      return;
    }
    visiting.add(task.databaseId);
    stack.push(task);
    const parent = task.parentDatabaseId ? byDatabaseId.get(task.parentDatabaseId) : undefined;
    if (parent) visit(parent);
    stack.pop();
    visiting.delete(task.databaseId);
    visited.add(task.databaseId);
  };
  for (const task of tasks) visit(task);

  return {
    tasks,
    leafTaskIds: tasks.filter((task) => (children.get(task.databaseId) ?? []).length === 0).map((task) => task.id),
    gaps: [...diagnostics.values()],
    frozenContractAmbiguousTaskIds: migrationAmbiguities.frozenContractTaskIds,
    frozenContractAmbiguityIsGlobal: migrationAmbiguities.frozenContractAmbiguityIsGlobal,
  };
}

export function loadManagedTaskMigrationAmbiguities(
  db: AppDatabase,
  goalId: string,
): ManagedTaskMigrationAmbiguities {
  const rows = db.prepare(`
    SELECT name, details FROM schema_migrations
    WHERE name IN ('managed-task-frozen-contract-repair-v1', 'managed-task-split-lineage-repair-v1')
  `).all() as Array<{ name: string; details: string }>;
  const detailsByName = new Map(rows.map((row) => [row.name, parseJsonObject(row.details)]));
  const frozenMarkerPresent = detailsByName.has("managed-task-frozen-contract-repair-v1");
  const frozenDetails = detailsByName.get("managed-task-frozen-contract-repair-v1") ?? null;
  const splitDetails = detailsByName.get("managed-task-split-lineage-repair-v1") ?? null;
  const frozenAmbiguity = frozenContractMigrationAmbiguityForGoal(
    db,
    goalId,
    frozenDetails,
    frozenMarkerPresent,
  );
  return {
    frozenContractTaskIds: frozenAmbiguity.taskIds,
    frozenContractAmbiguityIsGlobal: frozenAmbiguity.global,
    splitLineageTaskIds: migrationTaskIdsForGoal(
      db,
      goalId,
      [splitDetails?.ambiguousParents, splitDetails?.ambiguousTasks]
        .flatMap((entries) => Array.isArray(entries) ? entries : []),
    ),
    splitLineageMarkerPresent: detailsByName.has("managed-task-split-lineage-repair-v1"),
  };
}

export function lineageGapsForChange(
  projection: DurableLineageProjection,
  changeId: string,
): ManagedCompletionGap[] {
  const owned = new Set(projection.tasks.filter((task) => task.changeId === changeId).map((task) => task.id));
  const gaps = projection.gaps.filter((gap) =>
    (gap.taskIds ?? (gap.taskId ? [gap.taskId] : [])).some((taskId) => owned.has(taskId))
  );
  if (projection.frozenContractAmbiguityIsGlobal) {
    const globalGap = projection.gaps.find((gap) =>
      gap.reasonCode === "ambiguous_frozen_contract" && (gap.taskIds?.length ?? 0) === 0
    );
    return globalGap ? [globalGap, ...gaps] : gaps;
  }
  if (owned.size === 0) return gaps;
  const ambiguousTaskId = projection.frozenContractAmbiguousTaskIds.find((taskId) => owned.has(taskId));
  if (ambiguousTaskId && !gaps.some((gap) =>
    gap.reasonCode === "ambiguous_frozen_contract"
      && (gap.taskIds ?? (gap.taskId ? [gap.taskId] : [])).includes(ambiguousTaskId)
  )) {
    gaps.unshift(ambiguousFrozenContractGap(ambiguousTaskId));
  }
  return gaps;
}

function ambiguousFrozenContractGap(taskId: string): ManagedCompletionGap {
  return {
    type: "invalid_split_lineage",
    reasonCode: "ambiguous_frozen_contract",
    taskId,
    taskIds: [taskId],
    safeSummary: `Managed task ${taskId} has an ambiguous frozen acceptance contract (ambiguous_frozen_contract).`,
  };
}

function lineageError(reasonCode: string, message: string, taskIds: string[]): ManagedLineageValidationError {
  return new ManagedLineageValidationError(reasonCode, message, uniqueBounded(taskIds));
}

function uniqueBounded(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort().slice(0, MAX_DIAGNOSTIC_TASK_IDS);
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCriteria(
  a: Array<{ id: string; text: string }> | null,
  b: Array<{ id: string; text: string }> | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((criterion) => [criterion.id, criterion.text]));
  return b.every((criterion) => byId.get(criterion.id) === criterion.text);
}

function loadFrozenSplitEvidence(db: AppDatabase, goalId: string): Map<string, string[][]> {
  const evidence = new Map<string, Map<string, string[]>>();
  const add = (parentTaskId: unknown, rawTaskIds: unknown) => {
    if (typeof parentTaskId !== "string" || !Array.isArray(rawTaskIds)
      || rawTaskIds.some((taskId) => typeof taskId !== "string")) return;
    const taskIds = [...new Set(rawTaskIds as string[])].sort();
    const sets = evidence.get(parentTaskId) ?? new Map<string, string[]>();
    sets.set(JSON.stringify(taskIds), taskIds);
    evidence.set(parentTaskId, sets);
  };

  const events = db.prepare("SELECT data FROM events WHERE goal_id = ? ORDER BY created_at, rowid")
    .all(goalId) as Array<{ data: string }>;
  for (const event of events) {
    const data = parseJsonObject(event.data);
    if (data?.runtimeEventType !== "managed_task.lineage_split") continue;
    add(data.parentTaskId, data.taskIds);
  }

  const migration = db.prepare(`
    SELECT details FROM schema_migrations WHERE name = 'managed-task-split-lineage-repair-v1'
  `).get() as { details: string } | undefined;
  const details = migration ? parseJsonObject(migration.details) : null;
  if (Array.isArray(details?.frozenLineages)) {
    for (const raw of details.frozenLineages) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (record.goalId !== goalId) continue;
      add(record.parentTaskId, record.taskIds);
    }
  }

  return new Map([...evidence].map(([parentTaskId, sets]) => [parentTaskId, [...sets.values()]]));
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function migrationTaskIdsForGoal(db: AppDatabase, goalId: string, rawEntries: unknown): string[] {
  if (!Array.isArray(rawEntries)) return [];
  const goalTaskIds = new Set((db.prepare(`
    SELECT logical_task_id FROM managed_tasks WHERE goal_id = ?
  `).all(goalId) as Array<{ logical_task_id: string }>).map((task) => task.logical_task_id));
  const goalPrefix = `${goalId}:`;
  const affected = rawEntries.flatMap((entry) => {
    const taskId = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && "taskId" in entry
          && typeof (entry as { taskId?: unknown }).taskId === "string"
        ? (entry as { taskId: string }).taskId
        : null;
    if (!taskId) return [];
    if (goalTaskIds.has(taskId)) return [taskId];
    if (taskId.startsWith(goalPrefix)) {
      const logicalTaskId = taskId.slice(goalPrefix.length);
      if (goalTaskIds.has(logicalTaskId)) return [logicalTaskId];
    }
    return [];
  });
  return uniqueBounded(affected);
}

function frozenContractMigrationAmbiguityForGoal(
  db: AppDatabase,
  goalId: string,
  details: Record<string, unknown> | null,
  markerPresent: boolean,
): { taskIds: string[]; global: boolean } {
  if (!details) return { taskIds: [], global: markerPresent };
  const count = typeof details.ambiguousTaskCount === "number"
      && Number.isSafeInteger(details.ambiguousTaskCount)
      && details.ambiguousTaskCount >= 0
    ? details.ambiguousTaskCount
    : null;
  const completeEntries = details.ambiguousTaskEnforcementIds;
  if (Array.isArray(completeEntries)) {
    const completeIdentities = migrationDiagnosticIdentities(completeEntries);
    const completeRepresentationIsValid = completeIdentities.length === completeEntries.length
      && (count === null || count === completeIdentities.length);
    if (!completeRepresentationIsValid) {
      return { taskIds: [], global: (count ?? 0) > 0 || completeEntries.length > 0 };
    }
    return {
      taskIds: migrationTaskIdsForGoalUnbounded(db, goalId, completeIdentities),
      global: false,
    };
  }

  const boundedEntries = details.ambiguousTasks;
  if (!Array.isArray(boundedEntries)) {
    return { taskIds: [], global: (count ?? 0) > 0 };
  }
  const boundedIdentities = migrationDiagnosticIdentities(boundedEntries);
  if (count !== null && count !== boundedIdentities.length) {
    return { taskIds: [], global: count > 0 || boundedIdentities.length > 0 };
  }
  return {
    taskIds: migrationTaskIdsForGoalUnbounded(db, goalId, boundedIdentities),
    global: false,
  };
}

function migrationDiagnosticIdentities(rawEntries: unknown[]): string[] {
  return [...new Set(rawEntries.flatMap((entry) => {
    if (typeof entry === "string" && entry.length > 0) return [entry];
    if (entry && typeof entry === "object" && "taskId" in entry
        && typeof (entry as { taskId?: unknown }).taskId === "string") {
      return [(entry as { taskId: string }).taskId];
    }
    return [];
  }))].sort();
}

function migrationTaskIdsForGoalUnbounded(db: AppDatabase, goalId: string, rawEntries: unknown): string[] {
  if (!Array.isArray(rawEntries)) return [];
  const goalTaskIds = new Set((db.prepare(`
    SELECT logical_task_id FROM managed_tasks WHERE goal_id = ?
  `).all(goalId) as Array<{ logical_task_id: string }>).map((task) => task.logical_task_id));
  const goalPrefix = `${goalId}:`;
  return [...new Set(rawEntries.flatMap((entry) => {
    const identity = typeof entry === "string" ? entry : null;
    if (!identity) return [];
    if (goalTaskIds.has(identity)) return [identity];
    if (!identity.startsWith(goalPrefix)) return [];
    const logicalTaskId = identity.slice(goalPrefix.length);
    return goalTaskIds.has(logicalTaskId) ? [logicalTaskId] : [];
  }))].sort();
}
