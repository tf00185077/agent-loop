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
    SELECT id AS database_id, logical_task_id AS id, title, status
    FROM managed_tasks WHERE goal_id = ? ORDER BY created_at, rowid
  `).all(input.goalId) as Array<{ database_id: string; id: string; title: string; status: ManagedTaskStatus }>;
  const gaps: ManagedCompletionGap[] = [];
  const hasUncontractedWork = tasks.length === 0 && Boolean(db.prepare(`
    SELECT 1
    FROM agent_delegation_requests d
    JOIN agent_sessions s ON s.id = d.parent_session_id
    WHERE s.goal_id = ? AND d.role = 'worker'
      AND d.status IN ('completed', 'failed', 'cancelled', 'timed_out', 'detached', 'ignored')
      AND (d.task_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM managed_tasks t WHERE t.logical_task_id = d.task_id AND t.goal_id = s.goal_id
      ))
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
      .get(task.database_id) as { count: number }).count;
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
    `).all(task.database_id) as Array<{ criterion_id: string; outcome: string }>;
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

    const attempts = db.prepare(`
      SELECT d.id, d.status, d.result_summary
      FROM agent_delegation_requests d
      JOIN agent_sessions s ON s.id = d.parent_session_id
      JOIN managed_tasks owner ON owner.goal_id = s.goal_id AND owner.logical_task_id = d.task_id
      WHERE owner.id = ? AND d.role = 'worker'
      ORDER BY d.created_at, d.rowid
    `).all(task.database_id) as Array<{ id: string; status: string; result_summary: string | null }>;
    const activeAttempts = attempts.filter((attempt) => ["requested", "accepted", "running"].includes(attempt.status));
    for (const attempt of activeAttempts) {
      gaps.push({
        type: "active_attempt",
        taskId: task.id,
        delegationRequestId: attempt.id,
        safeSummary: `Worker attempt ${attempt.id} for task ${task.id} is still active.`,
      });
    }

    const pendingReviews = db.prepare(`
      SELECT worker_delegation_request_id FROM managed_task_reviews
      WHERE task_id = ? AND status = 'pending' ORDER BY created_at, rowid
    `).all(task.database_id) as Array<{ worker_delegation_request_id: string }>;
    if (task.status === "awaiting_review" || pendingReviews.length > 0) {
      gaps.push({ type: "pending_review", taskId: task.id, safeSummary: `Task ${task.id} is awaiting judge review.` });
    }
    const pendingDeliveries = db.prepare(`
      SELECT worker_delegation_request_id FROM managed_task_deliveries
      WHERE task_id = ? AND status = 'pending' ORDER BY created_at, rowid
    `).all(task.database_id) as Array<{ worker_delegation_request_id: string }>;
    if (task.status === "awaiting_delivery" || pendingDeliveries.length > 0) {
      gaps.push({ type: "pending_delivery", taskId: task.id, safeSummary: `Task ${task.id} is awaiting backend delivery.` });
    }

    const integrations = db.prepare(`
      SELECT id, status FROM managed_task_integrations WHERE task_id = ? ORDER BY created_at, rowid
    `).all(task.database_id) as Array<{ id: string; status: string }>;
    for (const integration of integrations) {
      if (integration.status === "committed" || integration.status === "rejected" || integration.status === "blocked") continue;
      gaps.push({
        type: "pending_integration",
        taskId: task.id,
        safeSummary: `Integration attempt ${integration.id} for task ${task.id} is ${integration.status}.`,
      });
    }

    const reviews = db.prepare(`
      SELECT worker_delegation_request_id, integration_attempt_id, reviewed_candidate_commit_sha,
        status, verdict
      FROM managed_task_reviews WHERE task_id = ? ORDER BY created_at, rowid
    `).all(task.database_id) as CandidateReviewRow[];
    const deliveryByWorker = new Map(
      (db.prepare(`
        SELECT worker_delegation_request_id, integration_attempt_id, candidate_commit_sha, status
        FROM managed_task_deliveries WHERE task_id = ? ORDER BY created_at, rowid
      `).all(task.database_id) as CandidateDeliveryRow[])
        .map((delivery) => [delivery.worker_delegation_request_id, delivery]),
    );
    const integrationById = new Map(
      (db.prepare(`
        SELECT id, worker_delegation_request_id, status, resolved_candidate_commit_sha
        FROM managed_task_integrations WHERE task_id = ? ORDER BY created_at, rowid
      `).all(task.database_id) as CandidateIntegrationRow[]).map((integration) => [integration.id, integration]),
    );
    const acceptedReviewByWorker = new Map<string, CandidateReviewRow>();
    for (const review of reviews) {
      if (review.status === "accepted" && review.verdict === "accepted") {
        acceptedReviewByWorker.set(review.worker_delegation_request_id, review);
      }
    }
    for (const attempt of attempts) {
      if (!attempt.result_summary) continue;
      const summary = parseSummary(attempt.result_summary);
      if ((summary?.attestedFiles?.length ?? 0) === 0) continue;
      const acceptedReview = acceptedReviewByWorker.get(attempt.id);
      if (!acceptedReview || !isDeliveryEligibleReview(acceptedReview, integrationById)) continue;
      const delivery = deliveryByWorker.get(attempt.id);
      const exactDelivery = delivery
        && delivery.integration_attempt_id === acceptedReview.integration_attempt_id
        && delivery.candidate_commit_sha === acceptedReview.reviewed_candidate_commit_sha;
      if (exactDelivery && delivery.status === "committed") continue;
      if (exactDelivery && delivery.status !== "pending") continue;
      gaps.push({
        type: "undelivered_changes",
        taskId: task.id,
        delegationRequestId: attempt.id,
        safeSummary: `Accepted candidate from worker attempt ${attempt.id} has not been delivered.`,
      });
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

interface CandidateReviewRow {
  worker_delegation_request_id: string;
  integration_attempt_id: string | null;
  reviewed_candidate_commit_sha: string | null;
  status: string;
  verdict: string | null;
}

interface CandidateDeliveryRow {
  worker_delegation_request_id: string;
  integration_attempt_id: string | null;
  candidate_commit_sha: string | null;
  status: string;
}

interface CandidateIntegrationRow {
  id: string;
  worker_delegation_request_id: string;
  status: string;
  resolved_candidate_commit_sha: string | null;
}

function isDeliveryEligibleReview(
  review: CandidateReviewRow,
  integrationById: Map<string, CandidateIntegrationRow>,
): boolean {
  if (!review.reviewed_candidate_commit_sha) return false;
  if (!review.integration_attempt_id) return true;
  const integration = integrationById.get(review.integration_attempt_id);
  return Boolean(
    integration
      && integration.worker_delegation_request_id === review.worker_delegation_request_id
      && integration.resolved_candidate_commit_sha === review.reviewed_candidate_commit_sha
      && ["accepted", "committed"].includes(integration.status),
  );
}

function parseSummary(value: string): AgentRuntimeDelegationSummary | null {
  try {
    return JSON.parse(value) as AgentRuntimeDelegationSummary;
  } catch {
    return null;
  }
}
