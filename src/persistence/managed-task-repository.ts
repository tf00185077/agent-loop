import { randomUUID } from "node:crypto";

import type {
  ManagedDeliveryOutcome,
  ManagedJudgeCriterionDecision,
  ManagedJudgeVerdict,
  ManagedIntegrationStatus,
  ManagedTaskCriterionRecord,
  ManagedTaskDeliveryRecord,
  ManagedTaskListEntry,
  ManagedTaskRecord,
  ManagedTaskStatus,
  ManagedTaskIntegrationRecord,
  TaskCriterionEvidence,
} from "../domain/index.js";
import type { AppDatabase } from "./database.js";

export interface ManagedTaskRepositoryOptions {
  now?: () => string;
}

export interface RegisterManagedTasksInput {
  goalId: string;
  changeId?: string | null;
  runId?: string | null;
  tasks: ManagedTaskListEntry[];
}

export interface ManagedTaskTransitionOptions {
  safeSummary: string;
  runId?: string | null;
  citedCriteria?: string[];
}

export interface RecordExecutorEvidenceInput {
  taskId: string;
  workerDelegationRequestId: string;
  safeSummary: string;
  criterionEvidence?: TaskCriterionEvidence[];
  runId?: string | null;
}

export interface RecordManagedReviewInput {
  taskId: string;
  workerDelegationRequestId: string;
  judgeDelegationRequestId: string | null;
  integrationAttemptId?: string | null;
  reviewedCandidateCommitSha?: string | null;
  verdict: ManagedJudgeVerdict;
  decisions: ManagedJudgeCriterionDecision[];
  safeSummary: string;
  deferredFindings?: string[];
  hasAttestedChanges: boolean;
  runId?: string | null;
}

export interface ManagedReviewRecord {
  id: string;
  taskId: string;
  workerDelegationRequestId: string;
  judgeDelegationRequestId: string | null;
  integrationAttemptId: string | null;
  reviewedCandidateCommitSha: string | null;
  status: "pending" | "accepted" | "rejected" | "blocked" | "malformed";
  verdict: ManagedJudgeVerdict | null;
  decisions: ManagedJudgeCriterionDecision[];
  citedCriteria: string[];
  safeSummary: string;
  deferredFindings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ManagedCriterionResultRecord {
  id: string;
  taskId: string;
  workerDelegationRequestId: string;
  criterionId: string;
  executorEvidence: string | null;
  judgeOutcome: "PASS" | "FAIL" | "BLOCKED" | null;
  judgeSafeSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordManagedDeliveryInput {
  taskId: string;
  workerDelegationRequestId: string;
  integrationAttemptId?: string | null;
  status: ManagedDeliveryOutcome;
  safeSummary: string;
  checkpointHead?: string | null;
  checkpointStatus?: string | null;
  candidateCommitSha?: string | null;
  commitSha?: string | null;
  validationCommand?: string | null;
  validationExitCode?: number | null;
  validationSummary?: string | null;
  rollbackSummary?: string | null;
  runId?: string | null;
}

export interface BeginManagedIntegrationInput {
  taskId: string;
  workerDelegationRequestId: string;
  checkpointHead: string;
  originalCandidateCommitSha: string;
  conflictFiles: string[];
  allowedFiles: string[];
  safeSummary: string;
  runId?: string | null;
}

export interface TransitionManagedIntegrationOptions {
  safeSummary: string;
  integratorDelegationRequestId?: string | null;
  resolvedCandidateCommitSha?: string | null;
  runId?: string | null;
}

export interface ManagedTaskRepository {
  registerTasks(input: RegisterManagedTasksInput): ManagedTaskRecord[];
  getTask(taskId: string): ManagedTaskRecord | null;
  listForGoal(goalId: string): ManagedTaskRecord[];
  listCriteria(taskId: string): ManagedTaskCriterionRecord[];
  beginAttempt(taskId: string, workerDelegationRequestId: string, runId?: string | null): number;
  transition(taskId: string, status: ManagedTaskStatus, options: ManagedTaskTransitionOptions): ManagedTaskRecord;
  recordExecutorEvidence(input: RecordExecutorEvidenceInput): ManagedTaskRecord;
  listCriterionResults(workerDelegationRequestId: string): ManagedCriterionResultRecord[];
  beginReview(input: {
    taskId: string;
    workerDelegationRequestId: string;
    judgeDelegationRequestId: string;
    integrationAttemptId?: string | null;
    reviewedCandidateCommitSha?: string | null;
    safeSummary: string;
    runId?: string | null;
  }): ManagedReviewRecord;
  recordInvalidReview(input: {
    taskId: string;
    workerDelegationRequestId: string;
    judgeDelegationRequestId: string;
    safeSummary: string;
    deferredFindings?: string[];
    runId?: string | null;
  }): ManagedReviewRecord;
  recordReview(input: RecordManagedReviewInput): ManagedReviewRecord;
  listReviews(taskId: string): ManagedReviewRecord[];
  recordDelivery(input: RecordManagedDeliveryInput): ManagedTaskDeliveryRecord;
  listDeliveries(taskId: string): ManagedTaskDeliveryRecord[];
  listPendingDeliveries(goalId: string): ManagedTaskDeliveryRecord[];
  beginIntegration(input: BeginManagedIntegrationInput): ManagedTaskIntegrationRecord;
  transitionIntegration(
    integrationAttemptId: string,
    status: ManagedIntegrationStatus,
    options: TransitionManagedIntegrationOptions,
  ): ManagedTaskIntegrationRecord;
  getIntegration(integrationAttemptId: string): ManagedTaskIntegrationRecord | null;
  listIntegrations(taskId: string): ManagedTaskIntegrationRecord[];
  interruptNonterminalIntegrations(goalId: string, safeSummary: string, runId?: string | null): number;
}

const integrationTransitions: Record<ManagedIntegrationStatus, readonly ManagedIntegrationStatus[]> = {
  pending: ["resolving", "resolution_failed", "interrupted"],
  resolving: ["awaiting_review", "resolution_failed", "interrupted"],
  awaiting_review: ["accepted", "rejected", "blocked", "resolution_failed", "interrupted"],
  accepted: ["committed", "resolution_failed", "interrupted"],
  rejected: [],
  blocked: [],
  resolution_failed: [],
  interrupted: [],
  committed: [],
};

const legalTransitions: Record<ManagedTaskStatus, readonly ManagedTaskStatus[]> = {
  registered: ["delegated", "split", "blocked", "failed"],
  delegated: ["awaiting_review", "failed", "blocked"],
  awaiting_review: ["rejected", "blocked", "awaiting_delivery", "accepted", "failed"],
  rejected: ["delegated", "split", "blocked", "failed"],
  split: [],
  failed: ["delegated", "split", "blocked"],
  blocked: ["delegated", "split", "failed"],
  awaiting_delivery: ["accepted", "rejected", "blocked", "failed"],
  accepted: [],
};

export function createManagedTaskRepository(
  db: AppDatabase,
  options: ManagedTaskRepositoryOptions = {},
): ManagedTaskRepository {
  const clock = options.now ?? (() => new Date().toISOString());

  const register = db.transaction((input: RegisterManagedTasksInput): ManagedTaskRecord[] => {
    const now = clock();
    const output: ManagedTaskRecord[] = [];
    let inserted = 0;
    for (const entry of input.tasks) {
      const existing = getTask(db, entry.id);
      if (existing) {
        if (existing.goalId !== input.goalId) {
          throw new Error(`Managed task id already belongs to another goal: ${entry.id}`);
        }
        output.push(existing);
        continue;
      }
      if (entry.parentTaskId) {
        const parent = getTask(db, entry.parentTaskId);
        if (!parent || parent.goalId !== input.goalId) {
          throw new Error(`Managed parent task not found in goal: ${entry.parentTaskId}`);
        }
      }
      db.prepare(`
        INSERT INTO managed_tasks (
          id, goal_id, change_id, parent_task_id, title, status, attempt_count,
          substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'registered', 0, 0, '[]', NULL, ?, ?)
      `).run(entry.id, input.goalId, input.changeId ?? null, entry.parentTaskId ?? null, entry.title, now, now);
      for (const criterion of entry.acceptance ?? []) {
        db.prepare(`
          INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at)
          VALUES (?, ?, ?, 'UNKNOWN', ?, ?)
        `).run(entry.id, criterion.id, criterion.text, now, now);
      }
      inserted += 1;
      output.push(getTask(db, entry.id)!);
    }
    if (inserted > 0) {
      insertAuditEvent(db, {
        goalId: input.goalId,
        runId: input.runId ?? null,
        message: `Registered ${inserted} managed task${inserted === 1 ? "" : "s"}.`,
        runtimeEventType: "managed_tasks.registered",
        data: { taskIds: output.map((task) => task.id) },
        now,
      });
    }
    return output;
  });

  const transitionTransaction = db.transaction(
    (taskId: string, status: ManagedTaskStatus, transitionOptions: ManagedTaskTransitionOptions): ManagedTaskRecord => {
      const task = requireTask(db, taskId);
      if (!legalTransitions[task.status].includes(status)) {
        throw new Error(`Cannot transition managed task from ${task.status} to ${status}.`);
      }
      const now = clock();
      db.prepare(`
        UPDATE managed_tasks
        SET status = ?, last_safe_summary = ?, last_cited_criteria = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status,
        transitionOptions.safeSummary,
        JSON.stringify(transitionOptions.citedCriteria ?? task.lastCitedCriteria),
        now,
        taskId,
      );
      insertAuditEvent(db, {
        goalId: task.goalId,
        runId: transitionOptions.runId ?? null,
        message: transitionOptions.safeSummary,
        runtimeEventType: "managed_task.transitioned",
        data: { taskId, from: task.status, to: status },
        now,
      });
      return requireTask(db, taskId);
    },
  );

  return {
    registerTasks: register,
    getTask(taskId) {
      return getTask(db, taskId);
    },
    listForGoal(goalId) {
      return db.prepare("SELECT * FROM managed_tasks WHERE goal_id = ? ORDER BY created_at, rowid").all(goalId).map(mapTask);
    },
    listCriteria(taskId) {
      return db
        .prepare("SELECT * FROM managed_task_criteria WHERE task_id = ? ORDER BY rowid")
        .all(taskId)
        .map(mapCriterion);
    },
    beginAttempt(taskId, workerDelegationRequestId, runId = null) {
      return db.transaction(() => {
        const task = requireTask(db, taskId);
        if (!legalTransitions[task.status].includes("delegated")) {
          throw new Error(`Cannot transition managed task from ${task.status} to delegated.`);
        }
        const delegation = db
          .prepare("SELECT task_id, role, attempt_number FROM agent_delegation_requests WHERE id = ?")
          .get(workerDelegationRequestId) as { task_id: string | null; role: string; attempt_number: number | null } | undefined;
        if (!delegation || delegation.role !== "worker" || delegation.task_id !== taskId) {
          throw new Error(`Worker delegation does not target managed task: ${workerDelegationRequestId}`);
        }
        if (delegation.attempt_number !== null) {
          throw new Error(`Worker delegation already has attempt number: ${workerDelegationRequestId}`);
        }
        const attemptNumber = task.attemptCount + 1;
        const now = clock();
        db.prepare("UPDATE agent_delegation_requests SET attempt_number = ?, updated_at = ? WHERE id = ?")
          .run(attemptNumber, now, workerDelegationRequestId);
        db.prepare(`
          UPDATE managed_tasks SET status = 'delegated', attempt_count = ?, last_safe_summary = ?, updated_at = ? WHERE id = ?
        `).run(attemptNumber, `Worker attempt ${attemptNumber} delegated.`, now, taskId);
        insertAuditEvent(db, {
          goalId: task.goalId, runId, message: `Worker attempt ${attemptNumber} delegated.`,
          runtimeEventType: "managed_task.attempt_started", data: { taskId, workerDelegationRequestId, attemptNumber }, now,
        });
        return attemptNumber;
      })();
    },
    transition(taskId, status, transitionOptions) {
      return transitionTransaction(taskId, status, transitionOptions);
    },
    recordExecutorEvidence(input) {
      return db.transaction(() => {
        const task = requireTask(db, input.taskId);
        if (task.status !== "delegated") {
          throw new Error(`Cannot record executor evidence while task is ${task.status}.`);
        }
        requireAttempt(db, input.taskId, input.workerDelegationRequestId);
        const criteria = new Map(listCriteria(db, input.taskId).map((item) => [item.criterionId, item]));
        const now = clock();
        for (const evidence of input.criterionEvidence ?? []) {
          if (!criteria.has(evidence.criterionId)) {
            throw new Error(`Unknown managed criterion: ${evidence.criterionId}`);
          }
          db.prepare(`
            INSERT INTO managed_task_criterion_results (
              id, task_id, worker_delegation_request_id, criterion_id, executor_evidence,
              judge_outcome, judge_safe_summary, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            ON CONFLICT(worker_delegation_request_id, criterion_id)
            DO UPDATE SET executor_evidence = excluded.executor_evidence, updated_at = excluded.updated_at
          `).run(randomUUID(), input.taskId, input.workerDelegationRequestId, evidence.criterionId, evidence.evidence, now, now);
        }
        db.prepare(`UPDATE managed_tasks SET status = 'awaiting_review', last_safe_summary = ?, updated_at = ? WHERE id = ?`)
          .run(input.safeSummary, now, input.taskId);
        insertAuditEvent(db, {
          goalId: task.goalId, runId: input.runId ?? null, message: input.safeSummary,
          runtimeEventType: "managed_task.executor_claim_recorded",
          data: { taskId: input.taskId, workerDelegationRequestId: input.workerDelegationRequestId }, now,
        });
        return requireTask(db, input.taskId);
      })();
    },
    listCriterionResults(workerDelegationRequestId) {
      return db.prepare(`
        SELECT * FROM managed_task_criterion_results
        WHERE worker_delegation_request_id = ? ORDER BY rowid
      `).all(workerDelegationRequestId).map(mapCriterionResult);
    },
    beginReview(input) {
      return db.transaction(() => {
        const task = requireTask(db, input.taskId);
        requireAttempt(db, input.taskId, input.workerDelegationRequestId);
        const integration = input.integrationAttemptId ? requireIntegration(db, input.integrationAttemptId) : null;
        if (integration) {
          validateIntegrationCandidate(integration, input.taskId, input.workerDelegationRequestId,
            input.reviewedCandidateCommitSha ?? null);
          if (integration.status !== "awaiting_review") {
            throw new Error(`Cannot begin integration review while integration is ${integration.status}.`);
          }
        } else if (task.status !== "awaiting_review") {
          throw new Error(`Cannot begin review while task is ${task.status}.`);
        }
        const now = clock();
        const id = randomUUID();
        db.prepare(`
          INSERT INTO managed_task_reviews (
            id, task_id, worker_delegation_request_id, judge_delegation_request_id,
            integration_attempt_id, reviewed_candidate_commit_sha, status, verdict,
            decisions, cited_criteria, safe_summary, deferred_findings, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, '[]', '[]', ?, '[]', ?, ?)
        `).run(id, input.taskId, input.workerDelegationRequestId, input.judgeDelegationRequestId,
          input.integrationAttemptId ?? null, input.reviewedCandidateCommitSha ?? null, input.safeSummary, now, now);
        insertAuditEvent(db, {
          goalId: task.goalId, runId: input.runId ?? null, message: input.safeSummary,
          runtimeEventType: "managed_task.review_started",
          data: { taskId: input.taskId, workerDelegationRequestId: input.workerDelegationRequestId,
            judgeDelegationRequestId: input.judgeDelegationRequestId,
            integrationAttemptId: input.integrationAttemptId ?? null }, now,
        });
        return getReview(db, id)!;
      })();
    },
    recordInvalidReview(input) {
      return db.transaction(() => {
        const task = requireTask(db, input.taskId);
        const existing = db.prepare(`
          SELECT id FROM managed_task_reviews WHERE judge_delegation_request_id = ? AND status = 'pending'
        `).get(input.judgeDelegationRequestId) as { id: string } | undefined;
        const now = clock();
        const id = existing?.id ?? randomUUID();
        if (existing) {
          db.prepare(`
            UPDATE managed_task_reviews SET status = 'malformed', safe_summary = ?, deferred_findings = ?, updated_at = ?
            WHERE id = ?
          `).run(input.safeSummary, JSON.stringify(input.deferredFindings ?? []), now, id);
        } else {
          db.prepare(`
            INSERT INTO managed_task_reviews (
              id, task_id, worker_delegation_request_id, judge_delegation_request_id, status, verdict,
              decisions, cited_criteria, safe_summary, deferred_findings, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'malformed', NULL, '[]', '[]', ?, ?, ?, ?)
          `).run(id, input.taskId, input.workerDelegationRequestId, input.judgeDelegationRequestId,
            input.safeSummary, JSON.stringify(input.deferredFindings ?? []), now, now);
        }
        insertAuditEvent(db, {
          goalId: task.goalId, runId: input.runId ?? null, message: input.safeSummary,
          runtimeEventType: "managed_task.review_rejected",
          data: { taskId: input.taskId, workerDelegationRequestId: input.workerDelegationRequestId }, now,
        });
        return getReview(db, id)!;
      })();
    },
    recordReview(input) {
      return db.transaction(() => {
        const task = requireTask(db, input.taskId);
        requireAttempt(db, input.taskId, input.workerDelegationRequestId);
        const integration = input.integrationAttemptId ? requireIntegration(db, input.integrationAttemptId) : null;
        if (integration) {
          validateIntegrationCandidate(integration, input.taskId, input.workerDelegationRequestId,
            input.reviewedCandidateCommitSha ?? null);
        }
        const duplicate = integration
          ? db.prepare("SELECT 1 FROM managed_task_reviews WHERE integration_attempt_id = ? AND verdict IS NOT NULL")
            .get(integration.id)
          : db.prepare("SELECT 1 FROM managed_task_reviews WHERE worker_delegation_request_id = ? AND integration_attempt_id IS NULL AND verdict IS NOT NULL")
            .get(input.workerDelegationRequestId);
        if (duplicate) {
          throw new Error(integration ? `Integration attempt already reviewed: ${integration.id}`
            : `Worker attempt already reviewed: ${input.workerDelegationRequestId}`);
        }
        const criteria = listCriteria(db, input.taskId);
        validateReview(criteria, input);
        const now = clock();
        const cited = input.decisions.map((decision) => decision.criterionId);
        for (const decision of input.decisions) {
          db.prepare(`
            INSERT INTO managed_task_criterion_results (
              id, task_id, worker_delegation_request_id, criterion_id, executor_evidence,
              judge_outcome, judge_safe_summary, created_at, updated_at
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
            ON CONFLICT(worker_delegation_request_id, criterion_id)
            DO UPDATE SET judge_outcome = excluded.judge_outcome,
                          judge_safe_summary = excluded.judge_safe_summary,
                          updated_at = excluded.updated_at
          `).run(
            randomUUID(), input.taskId, input.workerDelegationRequestId, decision.criterionId,
            decision.outcome, decision.safeSummary, now, now,
          );
          db.prepare(`UPDATE managed_task_criteria SET outcome = ?, updated_at = ? WHERE task_id = ? AND criterion_id = ?`)
            .run(decision.outcome, now, input.taskId, decision.criterionId);
        }
        const reviewStatus = input.verdict;
        const pending = input.judgeDelegationRequestId ? db.prepare(`
          SELECT id FROM managed_task_reviews WHERE judge_delegation_request_id = ? AND status = 'pending'
        `).get(input.judgeDelegationRequestId) as { id: string } | undefined : undefined;
        const reviewId = pending?.id ?? randomUUID();
        if (pending) {
          db.prepare(`
            UPDATE managed_task_reviews SET status = ?, verdict = ?, decisions = ?, cited_criteria = ?,
              integration_attempt_id = ?, reviewed_candidate_commit_sha = ?,
              safe_summary = ?, deferred_findings = ?, updated_at = ? WHERE id = ?
          `).run(reviewStatus, input.verdict, JSON.stringify(input.decisions), JSON.stringify(cited),
            input.integrationAttemptId ?? null, input.reviewedCandidateCommitSha ?? null,
            input.safeSummary, JSON.stringify(input.deferredFindings ?? []), now, reviewId);
        } else {
          db.prepare(`
            INSERT INTO managed_task_reviews (
              id, task_id, worker_delegation_request_id, judge_delegation_request_id,
              integration_attempt_id, reviewed_candidate_commit_sha, status, verdict,
              decisions, cited_criteria, safe_summary, deferred_findings, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            reviewId, input.taskId, input.workerDelegationRequestId, input.judgeDelegationRequestId,
            input.integrationAttemptId ?? null, input.reviewedCandidateCommitSha ?? null,
            reviewStatus, input.verdict, JSON.stringify(input.decisions), JSON.stringify(cited), input.safeSummary,
            JSON.stringify(input.deferredFindings ?? []), now, now,
          );
        }
        if (integration) {
          const integrationStatus: ManagedIntegrationStatus = input.verdict === "accepted"
            ? "accepted" : input.verdict === "blocked" ? "blocked" : "rejected";
          db.prepare("UPDATE managed_task_integrations SET status = ?, safe_summary = ?, updated_at = ? WHERE id = ?")
            .run(integrationStatus, input.safeSummary, now, integration.id);
        }
        const nextStatus: ManagedTaskStatus = input.verdict === "accepted"
          ? (input.hasAttestedChanges ? "awaiting_delivery" : "accepted")
          : input.verdict === "blocked" ? "blocked" : "rejected";
        const rejectionIncrement = input.verdict === "accepted" ? 0 : 1;
        db.prepare(`
          UPDATE managed_tasks
          SET status = ?, substantive_rejection_count = substantive_rejection_count + ?,
              last_cited_criteria = ?, last_safe_summary = ?, updated_at = ?
          WHERE id = ?
        `).run(nextStatus, rejectionIncrement, JSON.stringify(cited), input.safeSummary, now, input.taskId);
        insertAuditEvent(db, {
          goalId: task.goalId, runId: input.runId ?? null, message: input.safeSummary,
          runtimeEventType: "managed_task.review_recorded",
          data: { taskId: input.taskId, workerDelegationRequestId: input.workerDelegationRequestId, verdict: input.verdict }, now,
        });
        return getReview(db, reviewId)!;
      })();
    },
    listReviews(taskId) {
      return db.prepare("SELECT * FROM managed_task_reviews WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(mapReview);
    },
    recordDelivery(input) {
      return db.transaction(() => {
        const task = requireTask(db, input.taskId);
        requireAttempt(db, input.taskId, input.workerDelegationRequestId);
        const now = clock();
        const id = randomUUID();
        db.prepare(`
          INSERT INTO managed_task_deliveries (
            id, task_id, worker_delegation_request_id, integration_attempt_id, status, checkpoint_head, checkpoint_status,
            candidate_commit_sha, commit_sha, validation_command, validation_exit_code, validation_summary,
            rollback_summary, safe_summary, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(worker_delegation_request_id) DO UPDATE SET
            integration_attempt_id = excluded.integration_attempt_id,
            status = excluded.status, checkpoint_head = excluded.checkpoint_head,
            checkpoint_status = excluded.checkpoint_status, candidate_commit_sha = excluded.candidate_commit_sha,
            commit_sha = excluded.commit_sha, validation_command = excluded.validation_command,
            validation_exit_code = excluded.validation_exit_code, validation_summary = excluded.validation_summary,
            rollback_summary = excluded.rollback_summary, safe_summary = excluded.safe_summary, updated_at = excluded.updated_at
        `).run(
          id, input.taskId, input.workerDelegationRequestId, input.integrationAttemptId ?? null, input.status,
          input.checkpointHead ?? null, input.checkpointStatus ?? null, input.candidateCommitSha ?? null,
          input.commitSha ?? null, input.validationCommand ?? null, input.validationExitCode ?? null,
          input.validationSummary ?? null, input.rollbackSummary ?? null, input.safeSummary, now, now,
        );
        if (input.integrationAttemptId && input.status === "committed") {
          const integration = requireIntegration(db, input.integrationAttemptId);
          validateIntegrationCandidate(integration, input.taskId, input.workerDelegationRequestId,
            input.candidateCommitSha ?? null);
          if (integration.status !== "accepted") {
            throw new Error(`Cannot commit integration while integration is ${integration.status}.`);
          }
          db.prepare("UPDATE managed_task_integrations SET status = 'committed', safe_summary = ?, updated_at = ? WHERE id = ?")
            .run(input.safeSummary, now, integration.id);
        }
        const nextStatus: ManagedTaskStatus = input.status === "committed" ? "accepted"
          : input.status === "pending" ? "awaiting_delivery"
          : input.status === "conflict" ? "awaiting_delivery"
          : input.status === "rejected" ? "rejected"
          : input.status === "revert_failed" ? "blocked" : "failed";
        db.prepare("UPDATE managed_tasks SET status = ?, last_safe_summary = ?, updated_at = ? WHERE id = ?")
          .run(nextStatus, input.safeSummary, now, input.taskId);
        insertAuditEvent(db, {
          goalId: task.goalId, runId: input.runId ?? null, message: input.safeSummary,
          runtimeEventType: "managed_task.delivery_recorded",
          data: { taskId: input.taskId, workerDelegationRequestId: input.workerDelegationRequestId, status: input.status }, now,
        });
        return getDelivery(db, input.workerDelegationRequestId)!;
      })();
    },
    listDeliveries(taskId) {
      return db.prepare("SELECT * FROM managed_task_deliveries WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(mapDelivery);
    },
    listPendingDeliveries(goalId) {
      return db.prepare(`
        SELECT d.* FROM managed_task_deliveries d
        JOIN managed_tasks t ON t.id = d.task_id
        WHERE t.goal_id = ? AND d.status = 'pending'
        ORDER BY d.created_at, d.rowid
      `).all(goalId).map(mapDelivery);
    },
    beginIntegration(input) {
      return db.transaction(() => {
        const task = requireTask(db, input.taskId);
        requireAttempt(db, input.taskId, input.workerDelegationRequestId);
        const existing = db.prepare(`
          SELECT id FROM managed_task_integrations
          WHERE worker_delegation_request_id = ? AND original_candidate_commit_sha = ?
        `).get(input.workerDelegationRequestId, input.originalCandidateCommitSha) as { id: string } | undefined;
        if (existing) throw new Error(`Integration attempt already exists: ${existing.id}`);
        const now = clock();
        const id = randomUUID();
        db.prepare(`
          INSERT INTO managed_task_integrations (
            id, task_id, worker_delegation_request_id, integrator_delegation_request_id, status,
            checkpoint_head, original_candidate_commit_sha, resolved_candidate_commit_sha,
            conflict_files, allowed_files, safe_summary, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, 'pending', ?, ?, NULL, ?, ?, ?, ?, ?)
        `).run(id, input.taskId, input.workerDelegationRequestId, input.checkpointHead,
          input.originalCandidateCommitSha, JSON.stringify(uniqueSorted(input.conflictFiles)),
          JSON.stringify(uniqueSorted(input.allowedFiles)), input.safeSummary, now, now);
        db.prepare("UPDATE managed_tasks SET status = 'awaiting_delivery', last_safe_summary = ?, updated_at = ? WHERE id = ?")
          .run(input.safeSummary, now, input.taskId);
        insertAuditEvent(db, {
          goalId: task.goalId, runId: input.runId ?? null, message: input.safeSummary,
          runtimeEventType: "managed_task.integration_started",
          data: { taskId: input.taskId, workerDelegationRequestId: input.workerDelegationRequestId,
            integrationAttemptId: id, originalCandidateCommitSha: input.originalCandidateCommitSha }, now,
        });
        return requireIntegration(db, id);
      })();
    },
    transitionIntegration(integrationAttemptId, status, transitionOptions) {
      return db.transaction(() => {
        const current = requireIntegration(db, integrationAttemptId);
        if (!integrationTransitions[current.status].includes(status)) {
          throw new Error(`Cannot transition integration ${integrationAttemptId} from ${current.status} to ${status}.`);
        }
        if (status === "resolving" && !transitionOptions.integratorDelegationRequestId) {
          throw new Error("Resolving integration requires an Integrator delegation.");
        }
        if (status === "awaiting_review" && !transitionOptions.resolvedCandidateCommitSha) {
          throw new Error("Awaiting review requires a resolved candidate commit SHA.");
        }
        const task = requireTask(db, current.taskId);
        const now = clock();
        db.prepare(`
          UPDATE managed_task_integrations SET status = ?, integrator_delegation_request_id = COALESCE(?, integrator_delegation_request_id),
            resolved_candidate_commit_sha = COALESCE(?, resolved_candidate_commit_sha), safe_summary = ?, updated_at = ?
          WHERE id = ?
        `).run(status, transitionOptions.integratorDelegationRequestId ?? null,
          transitionOptions.resolvedCandidateCommitSha ?? null, transitionOptions.safeSummary, now, integrationAttemptId);
        insertAuditEvent(db, {
          goalId: task.goalId, runId: transitionOptions.runId ?? null, message: transitionOptions.safeSummary,
          runtimeEventType: "managed_task.integration_transitioned",
          data: { taskId: current.taskId, workerDelegationRequestId: current.workerDelegationRequestId,
            integrationAttemptId, status }, now,
        });
        return requireIntegration(db, integrationAttemptId);
      })();
    },
    getIntegration(integrationAttemptId) {
      return getIntegration(db, integrationAttemptId);
    },
    listIntegrations(taskId) {
      return db.prepare("SELECT * FROM managed_task_integrations WHERE task_id = ? ORDER BY created_at, rowid")
        .all(taskId).map(mapIntegration);
    },
    interruptNonterminalIntegrations(goalId, safeSummary, runId = null) {
      return db.transaction(() => {
        const rows = db.prepare(`
          SELECT i.* FROM managed_task_integrations i
          JOIN managed_tasks t ON t.id = i.task_id
          WHERE t.goal_id = ? AND i.status IN ('pending', 'resolving', 'awaiting_review', 'accepted')
        `).all(goalId).map(mapIntegration);
        const now = clock();
        for (const integration of rows) {
          db.prepare("UPDATE managed_task_integrations SET status = 'interrupted', safe_summary = ?, updated_at = ? WHERE id = ?")
            .run(safeSummary, now, integration.id);
          insertAuditEvent(db, {
            goalId, runId, message: safeSummary, runtimeEventType: "managed_task.integration_interrupted",
            data: { taskId: integration.taskId, workerDelegationRequestId: integration.workerDelegationRequestId,
              integrationAttemptId: integration.id }, now,
          });
        }
        return rows.length;
      })();
    },
  };
}

function validateReview(criteria: ManagedTaskCriterionRecord[], input: RecordManagedReviewInput): void {
  const expected = new Set(criteria.map((criterion) => criterion.criterionId));
  const actual = new Set(input.decisions.map((decision) => decision.criterionId));
  if (actual.size !== input.decisions.length || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) {
    throw new Error("Judge decision must cover every and only frozen criterion exactly once.");
  }
  const outcomes = input.decisions.map((decision) => decision.outcome);
  if (input.verdict === "accepted" && outcomes.some((outcome) => outcome !== "PASS")) {
    throw new Error("Accepted judge verdict requires every criterion to PASS.");
  }
  if (input.verdict === "rejected" && !outcomes.includes("FAIL")) {
    throw new Error("Rejected judge verdict requires a FAIL criterion.");
  }
  if (input.verdict === "blocked" && !outcomes.includes("BLOCKED")) {
    throw new Error("Blocked judge verdict requires a BLOCKED criterion.");
  }
}

function requireAttempt(db: AppDatabase, taskId: string, requestId: string): void {
  const row = db.prepare(`
    SELECT 1 FROM agent_delegation_requests
    WHERE id = ? AND task_id = ? AND role = 'worker' AND attempt_number IS NOT NULL
  `).get(requestId, taskId);
  if (!row) throw new Error(`Managed worker attempt not found: ${requestId}`);
}

function getTask(db: AppDatabase, taskId: string): ManagedTaskRecord | null {
  const row = db.prepare("SELECT * FROM managed_tasks WHERE id = ?").get(taskId);
  return row ? mapTask(row) : null;
}

function requireTask(db: AppDatabase, taskId: string): ManagedTaskRecord {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Managed task not found: ${taskId}`);
  return task;
}

function listCriteria(db: AppDatabase, taskId: string): ManagedTaskCriterionRecord[] {
  return db.prepare("SELECT * FROM managed_task_criteria WHERE task_id = ? ORDER BY rowid").all(taskId).map(mapCriterion);
}

function mapTask(row: unknown): ManagedTaskRecord {
  const value = row as Record<string, string | number | null>;
  return {
    id: value.id as string,
    goalId: value.goal_id as string,
    changeId: value.change_id as string | null,
    parentTaskId: value.parent_task_id as string | null,
    title: value.title as string,
    status: value.status as ManagedTaskStatus,
    attemptCount: value.attempt_count as number,
    substantiveRejectionCount: value.substantive_rejection_count as number,
    lastCitedCriteria: JSON.parse(value.last_cited_criteria as string) as string[],
    lastSafeSummary: value.last_safe_summary as string | null,
    createdAt: value.created_at as string,
    updatedAt: value.updated_at as string,
  };
}

function mapCriterion(row: unknown): ManagedTaskCriterionRecord {
  const value = row as Record<string, string>;
  return {
    taskId: value.task_id,
    criterionId: value.criterion_id,
    text: value.text,
    outcome: value.outcome as ManagedTaskCriterionRecord["outcome"],
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function mapCriterionResult(row: unknown): ManagedCriterionResultRecord {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!, taskId: value.task_id!, workerDelegationRequestId: value.worker_delegation_request_id!,
    criterionId: value.criterion_id!, executorEvidence: value.executor_evidence,
    judgeOutcome: value.judge_outcome as ManagedCriterionResultRecord["judgeOutcome"],
    judgeSafeSummary: value.judge_safe_summary, createdAt: value.created_at!, updatedAt: value.updated_at!,
  };
}

function getReview(db: AppDatabase, id: string): ManagedReviewRecord | null {
  const row = db.prepare("SELECT * FROM managed_task_reviews WHERE id = ?").get(id);
  return row ? mapReview(row) : null;
}

function mapReview(row: unknown): ManagedReviewRecord {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!, taskId: value.task_id!, workerDelegationRequestId: value.worker_delegation_request_id!,
    judgeDelegationRequestId: value.judge_delegation_request_id,
    integrationAttemptId: value.integration_attempt_id,
    reviewedCandidateCommitSha: value.reviewed_candidate_commit_sha,
    status: value.status as ManagedReviewRecord["status"], verdict: value.verdict as ManagedJudgeVerdict | null,
    decisions: JSON.parse(value.decisions ?? "[]") as ManagedJudgeCriterionDecision[],
    citedCriteria: JSON.parse(value.cited_criteria ?? "[]") as string[], safeSummary: value.safe_summary!,
    deferredFindings: JSON.parse(value.deferred_findings ?? "[]") as string[], createdAt: value.created_at!, updatedAt: value.updated_at!,
  };
}

function getDelivery(db: AppDatabase, workerDelegationRequestId: string): ManagedTaskDeliveryRecord | null {
  const row = db.prepare("SELECT * FROM managed_task_deliveries WHERE worker_delegation_request_id = ?").get(workerDelegationRequestId);
  return row ? mapDelivery(row) : null;
}

function mapDelivery(row: unknown): ManagedTaskDeliveryRecord {
  const value = row as Record<string, string | number | null>;
  return {
    id: value.id as string, taskId: value.task_id as string,
    workerDelegationRequestId: value.worker_delegation_request_id as string,
    integrationAttemptId: value.integration_attempt_id as string | null,
    status: value.status as ManagedDeliveryOutcome, checkpointHead: value.checkpoint_head as string | null,
    checkpointStatus: value.checkpoint_status as string | null, candidateCommitSha: value.candidate_commit_sha as string | null,
    commitSha: value.commit_sha as string | null, validationCommand: value.validation_command as string | null,
    validationExitCode: value.validation_exit_code as number | null, validationSummary: value.validation_summary as string | null,
    rollbackSummary: value.rollback_summary as string | null, safeSummary: value.safe_summary as string,
    createdAt: value.created_at as string, updatedAt: value.updated_at as string,
  };
}

function getIntegration(db: AppDatabase, integrationAttemptId: string): ManagedTaskIntegrationRecord | null {
  const row = db.prepare("SELECT * FROM managed_task_integrations WHERE id = ?").get(integrationAttemptId);
  return row ? mapIntegration(row) : null;
}

function requireIntegration(db: AppDatabase, integrationAttemptId: string): ManagedTaskIntegrationRecord {
  const integration = getIntegration(db, integrationAttemptId);
  if (!integration) throw new Error(`Managed integration attempt not found: ${integrationAttemptId}`);
  return integration;
}

function mapIntegration(row: unknown): ManagedTaskIntegrationRecord {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    taskId: value.task_id!,
    workerDelegationRequestId: value.worker_delegation_request_id!,
    integratorDelegationRequestId: value.integrator_delegation_request_id,
    status: value.status as ManagedIntegrationStatus,
    checkpointHead: value.checkpoint_head!,
    originalCandidateCommitSha: value.original_candidate_commit_sha!,
    resolvedCandidateCommitSha: value.resolved_candidate_commit_sha,
    conflictFiles: JSON.parse(value.conflict_files ?? "[]") as string[],
    allowedFiles: JSON.parse(value.allowed_files ?? "[]") as string[],
    safeSummary: value.safe_summary!,
    createdAt: value.created_at!,
    updatedAt: value.updated_at!,
  };
}

function validateIntegrationCandidate(
  integration: ManagedTaskIntegrationRecord,
  taskId: string,
  workerDelegationRequestId: string,
  reviewedCandidateCommitSha: string | null,
): void {
  if (integration.taskId !== taskId || integration.workerDelegationRequestId !== workerDelegationRequestId) {
    throw new Error("Integration attempt does not target the managed worker attempt.");
  }
  if (!integration.resolvedCandidateCommitSha || reviewedCandidateCommitSha !== integration.resolvedCandidateCommitSha) {
    throw new Error("Judge review must target the exact resolved candidate commit SHA.");
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function insertAuditEvent(db: AppDatabase, input: {
  goalId: string;
  runId: string | null;
  message: string;
  runtimeEventType: string;
  data: Record<string, unknown>;
  now: string;
}): void {
  db.prepare(`
    INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at)
    VALUES (?, ?, ?, NULL, 'agent.decision', ?, ?, ?)
  `).run(
    randomUUID(), input.goalId, input.runId, input.message,
    JSON.stringify({ runtimeEventType: input.runtimeEventType, ...input.data }), input.now,
  );
}
