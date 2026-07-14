import type {
  ManagedCriterionOutcome,
  ManagedDeliveryOutcome,
  ManagedJudgeVerdict,
  ManagedIntegrationStatus,
  ManagedTaskStatus,
} from "../../domain/index.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";

export interface ManagedTaskContextRecord {
  id: string;
  title: string;
  status: ManagedTaskStatus;
  parentTaskId: string | null;
  attemptCount: number;
  substantiveRejectionCount: number;
  lastCitedCriteria: string[];
  lastSafeSummary: string;
  criteria: Array<{ id: string; text: string; outcome: ManagedCriterionOutcome }>;
  lastJudgeVerdict: ManagedJudgeVerdict | null;
  lastDeliveryStatus: ManagedDeliveryOutcome | null;
  lastIntegrationStatus: ManagedIntegrationStatus | null;
  integrationAttemptId: string | null;
  resolvedCandidateCommitSha: string | null;
}

export function projectManagedTaskContext(
  repository: ManagedTaskRepository,
  goalId: string,
): ManagedTaskContextRecord[] {
  return repository.listForGoal(goalId).map((task) => {
    const reviews = repository.listReviews(task.id);
    const deliveries = repository.listDeliveries(task.id);
    const integration = repository.listIntegrations(task.id).at(-1);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      parentTaskId: task.parentTaskId,
      attemptCount: task.attemptCount,
      substantiveRejectionCount: task.substantiveRejectionCount,
      lastCitedCriteria: task.lastCitedCriteria,
      lastSafeSummary: bounded(task.lastSafeSummary),
      criteria: repository.listCriteria(task.id).map((criterion) => ({
        id: criterion.criterionId,
        text: criterion.text,
        outcome: criterion.outcome,
      })),
      lastJudgeVerdict: reviews.at(-1)?.verdict ?? null,
      lastDeliveryStatus: deliveries.at(-1)?.status ?? null,
      lastIntegrationStatus: integration?.status ?? null,
      integrationAttemptId: integration?.id ?? null,
      resolvedCandidateCommitSha: integration?.resolvedCandidateCommitSha ?? null,
    };
  });
}

function bounded(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
