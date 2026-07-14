import type { AgentRuntimeDelegationSummary, ManagedCompletionGap, ManagedTaskStatus } from "../../domain/index.js";
import type { AppDatabase } from "../../persistence/database.js";

export interface ManagedCompletionEvaluationInput {
  goalId: string;
  unarchivedChangeIds?: string[];
}

export interface ManagedCompletionEvaluation {
  ok: boolean;
  gaps: ManagedCompletionGap[];
}

export function evaluateManagedCompletion(
  db: AppDatabase,
  input: ManagedCompletionEvaluationInput,
): ManagedCompletionEvaluation {
  const tasks = db.prepare(`
    SELECT id, title, status FROM managed_tasks WHERE goal_id = ? ORDER BY created_at, rowid
  `).all(input.goalId) as Array<{ id: string; title: string; status: ManagedTaskStatus }>;
  const gaps: ManagedCompletionGap[] = [];
  const hasUncontractedWork = tasks.length === 0 && Boolean(db.prepare(`
    SELECT 1
    FROM agent_delegation_requests d
    JOIN agent_sessions s ON s.id = d.parent_session_id
    WHERE s.goal_id = ? AND d.role = 'worker'
      AND d.status IN ('completed', 'failed', 'cancelled', 'timed_out', 'detached', 'ignored')
      AND (d.task_id IS NULL OR NOT EXISTS (SELECT 1 FROM managed_tasks t WHERE t.id = d.task_id AND t.goal_id = s.goal_id))
    LIMIT 1
  `).get(input.goalId));
  if (hasUncontractedWork) {
    gaps.push({
      type: "uncontracted_only_work",
      safeSummary: "No contracted managed tasks are registered for this goal.",
    });
  }

  for (const task of tasks) {
    const childCount = (db.prepare("SELECT COUNT(*) AS count FROM managed_tasks WHERE parent_task_id = ?")
      .get(task.id) as { count: number }).count;
    const isLeaf = childCount === 0;
    if (isLeaf && task.status !== "accepted") {
      gaps.push({
        type: "unaccepted_leaf_task",
        taskId: task.id,
        safeSummary: `Managed leaf task ${task.id} is ${task.status}, not accepted.`,
      });
    }
    if (!isLeaf) continue;

    const criteria = db.prepare(`
      SELECT criterion_id, outcome FROM managed_task_criteria WHERE task_id = ? ORDER BY rowid
    `).all(task.id) as Array<{ criterion_id: string; outcome: string }>;
    for (const criterion of criteria) {
      if (criterion.outcome !== "PASS") {
        gaps.push({
          type: "criterion_not_passed",
          taskId: task.id,
          criterionId: criterion.criterion_id,
          safeSummary: `Criterion ${criterion.criterion_id} for task ${task.id} is ${criterion.outcome}.`,
        });
      }
    }

    const activeAttempts = db.prepare(`
      SELECT id FROM agent_delegation_requests
      WHERE task_id = ? AND role = 'worker' AND status IN ('requested', 'accepted', 'running')
      ORDER BY created_at, rowid
    `).all(task.id) as Array<{ id: string }>;
    for (const attempt of activeAttempts) {
      gaps.push({
        type: "active_attempt",
        taskId: task.id,
        delegationRequestId: attempt.id,
        safeSummary: `Worker attempt ${attempt.id} for task ${task.id} is still active.`,
      });
    }

    if (task.status === "awaiting_review") {
      gaps.push({ type: "pending_review", taskId: task.id, safeSummary: `Task ${task.id} is awaiting judge review.` });
    }
    if (task.status === "awaiting_delivery") {
      gaps.push({ type: "pending_delivery", taskId: task.id, safeSummary: `Task ${task.id} is awaiting backend delivery.` });
    }

    const attempts = db.prepare(`
      SELECT id, result_summary FROM agent_delegation_requests
      WHERE task_id = ? AND role = 'worker' AND result_summary IS NOT NULL
    `).all(task.id) as Array<{ id: string; result_summary: string }>;
    for (const attempt of attempts) {
      const summary = parseSummary(attempt.result_summary);
      if ((summary?.attestedFiles?.length ?? 0) === 0) continue;
      const committed = db.prepare(`
        SELECT 1 FROM managed_task_deliveries
        WHERE worker_delegation_request_id = ? AND status = 'committed'
      `).get(attempt.id);
      if (!committed) {
        gaps.push({
          type: "undelivered_changes",
          taskId: task.id,
          delegationRequestId: attempt.id,
          safeSummary: `Attested changes from worker attempt ${attempt.id} have not been delivered.`,
        });
      }
    }
  }

  for (const changeId of input.unarchivedChangeIds ?? []) {
    gaps.push({
      type: "unarchived_change",
      changeId,
      safeSummary: `Planned change ${changeId} is not archived.`,
    });
  }
  return { ok: gaps.length === 0, gaps };
}

function parseSummary(value: string): AgentRuntimeDelegationSummary | null {
  try {
    return JSON.parse(value) as AgentRuntimeDelegationSummary;
  } catch {
    return null;
  }
}
