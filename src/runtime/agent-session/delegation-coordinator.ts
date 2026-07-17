import type {
  AgentRuntimeAdapter,
  AgentRuntimeDelegationRole,
  AgentRuntimeDelegationSummary,
  AgentSessionHandle,
  AgentRuntimeEvent,
  AgentRuntimeReviewMergeApplyOutcome,
  AgentRuntimeReviewMergeCheckpoint,
  AgentRuntimeWorktreeMetadata,
  ManagedReviewDecisionControlEvent,
  ManagedIntegrationResultControlEvent,
  TaskAcceptanceCriterion,
} from "../../domain/index.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import type {
  AgentSessionRepository,
  EventRepository,
  RunRepository,
} from "../../persistence/runtime-repositories.js";
import { validateManagedIntegrationResult, validateManagedReviewDecision, validateManagedTaskResult, type ManagedTaskResult } from "./delegation-control-event.js";
import { buildJudgeContractAppendix, buildWorkerContractAppendix } from "./supervisor-prompt.js";
import {
  attestWorktreeFiles,
  createGitWorktreeService,
  type WorktreeAttestor,
  type WorktreeService,
} from "./worktree-service.js";
import {
  createGitReviewMergeWorkspaceService,
  type ReviewMergeWorkspaceService,
} from "./review-merge-workspace-service.js";
import {
  createReviewMergeVerificationService,
  type ReviewMergeVerificationService,
} from "./review-merge-verification-service.js";
import { recordUnhandledRuntimeFailure } from "./unhandled-failure.js";

export interface DelegationCoordinatorDeps {
  runRepo: RunRepository;
  eventRepo: EventRepository;
  agentSessionRepo: AgentSessionRepository;
  worktreeService?: WorktreeService;
  /** Reads authoritative changed files from a worker worktree at terminal. */
  worktreeAttestor?: WorktreeAttestor;
  reviewMergeWorkspaceService?: ReviewMergeWorkspaceService;
  reviewMergeVerificationService?: ReviewMergeVerificationService;
  supervisorCwd?: string;
  managedTaskRepo?: ManagedTaskRepository;
  /**
   * Live session handles keyed by session id. When provided, child handles
   * are registered for their lifetime so a supervisor cancel can cascade to
   * in-flight children (otherwise their provider processes keep running).
   */
  activeHandles?: Map<string, AgentSessionHandle>;
}

export interface StartWorkerDelegationInput {
  parentSessionId: string;
  providerId: string;
  modelLabel: string | null;
  role: AgentRuntimeDelegationRole;
  prompt: string;
  promptSummary: string;
  taskId?: string | null;
  changeId?: string | null;
  acceptance?: TaskAcceptanceCriterion[] | null;
  /** Extra role-specific instructions appended after the contract appendix. */
  promptAppendix?: string | null;
  workerDelegationRequestId?: string | null;
  integrationContext?: {
    integrationAttemptId: string;
    workerDelegationRequestId: string;
    checkpointHead: string;
    originalCandidateCommitSha: string;
    worktreePath: string;
  } | null;
  reviewCandidateContext?: {
    integrationAttemptId: string;
    resolvedCandidateCommitSha: string;
    worktreePath: string;
  } | null;
  adapter: AgentRuntimeAdapter;
  eventData: Record<string, unknown>;
  onChildOutcome?: (input: SupervisorContinuationInput) => Promise<void>;
  /** Fires with the accepted delegation request id before the child starts. */
  onAccepted?: (delegationRequestId: string) => void;
}

export interface SupervisorContinuationInput {
  parentSessionId: string;
  delegationRequestId: string;
  childSessionId: string;
  observation: string;
  role: AgentRuntimeDelegationRole;
  taskId: string | null;
  /** For review_merge children: the task of the worker result under review. */
  workerTaskId: string | null;
  /** The worker child's isolated worktree, when one was created. */
  worktreePath: string | null;
  resultSummary: AgentRuntimeDelegationSummary;
  reviewMergeOutcome: string | null;
  reviewDecision: ManagedReviewDecisionControlEvent | null;
  reviewDecisionError: string | null;
  workerDelegationRequestId: string | null;
  integrationAttemptId: string | null;
  reviewedCandidateCommitSha: string | null;
  integrationResult: ManagedIntegrationResultControlEvent | null;
  integrationResultError: string | null;
}

export interface DelegationCoordinator {
  acceptAndStartWorker(input: StartWorkerDelegationInput): Promise<void>;
}

export function createDelegationCoordinator(deps: DelegationCoordinatorDeps): DelegationCoordinator {
  const worktreeService = deps.worktreeService ?? createGitWorktreeService();
  const reviewMergeWorkspaceService = deps.reviewMergeWorkspaceService ?? createGitReviewMergeWorkspaceService();
  const reviewMergeVerificationService = deps.reviewMergeVerificationService ?? createReviewMergeVerificationService();
  const supervisorCwd = deps.supervisorCwd ?? process.cwd();

  return {
    async acceptAndStartWorker(input) {
      const parent = deps.agentSessionRepo.getSession(input.parentSessionId);
      if (!parent) {
        throw new Error(`Agent session not found: ${input.parentSessionId}`);
      }
      const workerResult = input.role === "review_merge" ? requireWorkerResult(deps, parent, input.workerDelegationRequestId) : null;
      const checkpoint =
        input.role === "review_merge" && !deps.managedTaskRepo
          ? await prepareReviewMerge(reviewMergeWorkspaceService, supervisorCwd)
          : null;
      const childEventData = {
        ...input.eventData,
        ...(checkpoint ? { reviewMergeCheckpoint: checkpoint } : {}),
      };

      const request = deps.agentSessionRepo.createDelegationRequest({
        parentSessionId: parent.id,
        role: input.role,
        promptSummary: workerResult
          ? `${input.promptSummary} (worker result: ${workerResult.resultSummary.safeSummary})`
          : input.promptSummary,
        taskId: input.taskId ?? null,
        changeId: input.changeId ?? null,
        acceptance: input.acceptance ?? null,
      });
      const accepted = deps.agentSessionRepo.acceptDelegationRequest(request.id);
      if (input.role === "worker" && input.taskId && deps.managedTaskRepo?.getTask(parent.goalId, input.taskId)) {
        deps.managedTaskRepo.beginAttempt(input.taskId, accepted.id, parent.runId, parent.goalId);
      }
      input.onAccepted?.(accepted.id);
      if (input.role === "review_merge" && workerResult?.taskId &&
          deps.managedTaskRepo?.getTask(parent.goalId, workerResult.taskId)) {
        deps.managedTaskRepo.beginReview({
          goalId: parent.goalId,
          taskId: workerResult.taskId,
          workerDelegationRequestId: workerResult.id,
          judgeDelegationRequestId: accepted.id,
          integrationAttemptId: input.reviewCandidateContext?.integrationAttemptId ?? null,
          reviewedCandidateCommitSha: input.reviewCandidateContext?.resolvedCandidateCommitSha ?? null,
          safeSummary: "Independent judge review started.",
          runId: parent.runId,
        });
      }
      deps.eventRepo.create({
        goalId: parent.goalId,
        runId: parent.runId,
        type: "agent.progress",
        message: "Delegation request accepted.",
        data: {
          ...input.eventData,
          delegationControlEvent: undefined,
          runtimeEventType: "delegation.accepted",
          delegationRequestId: accepted.id,
          delegationRole: accepted.role,
          ...(accepted.taskId ? { taskId: accepted.taskId } : {}),
          ...(accepted.changeId ? { changeId: accepted.changeId } : {}),
        },
      });

      const childCapabilities = await input.adapter.detectCapabilities();
      const childRun = deps.runRepo.create({
        goalId: parent.goalId,
        provider: input.providerId,
        model: input.modelLabel ?? "unknown",
      });
      const provisionalWorktree = input.role === "worker" ? childWorktreeMetadata(childRun.id) : null;
      const childSession = deps.agentSessionRepo.createSession({
        goalId: parent.goalId,
        runId: childRun.id,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        lifecycleState: "starting",
        capabilities: childCapabilities,
        parent: { sessionId: parent.id },
        worktree: provisionalWorktree,
      });
      const childCwd =
        input.role === "worker"
          ? await createWorkerCwd(worktreeService, supervisorCwd, childSession.id, deps.agentSessionRepo)
          : input.role === "integrator" && input.integrationContext
            ? { path: input.integrationContext.worktreePath, worktree: null }
            : input.reviewCandidateContext
              ? { path: input.reviewCandidateContext.worktreePath, worktree: null }
              : { path: workerResult?.worktreePath ?? supervisorCwd, worktree: null };
      const contractedPrompt =
        input.role === "worker" && input.acceptance && input.acceptance.length > 0
          ? `${input.prompt}\n\n${buildWorkerContractAppendix(input.acceptance, input.taskId ?? null)}`
          : input.prompt;
      const judgePrompt = input.role === "review_merge" && workerResult && deps.managedTaskRepo
        ? `${contractedPrompt}\n\n${buildJudgeContractAppendix({
            workerDelegationRequestId: workerResult.id,
            acceptance: workerResult.acceptance ?? [],
            resultSummary: workerResult.resultSummary,
            integrationAttemptId: input.reviewCandidateContext?.integrationAttemptId ?? null,
            reviewedCandidateCommitSha: input.reviewCandidateContext?.resolvedCandidateCommitSha ?? null,
          })}`
        : contractedPrompt;
      const childPrompt = input.promptAppendix ? `${judgePrompt}\n\n${input.promptAppendix}` : judgePrompt;
      const handle = await input.adapter.startSession({
        sessionId: childSession.id,
        goalId: parent.goalId,
        runId: childRun.id,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        prompt: childPrompt,
        parent: { sessionId: parent.id },
        cwd: childCwd.path,
      });

      const running = deps.agentSessionRepo.startDelegationRequest(accepted.id, childSession.id);
      if (input.role === "integrator" && input.integrationContext && deps.managedTaskRepo) {
        deps.managedTaskRepo.transitionIntegration(input.integrationContext.integrationAttemptId, "resolving", {
          safeSummary: "Integrator conflict recovery started.",
          integratorDelegationRequestId: accepted.id,
          runId: parent.runId,
        });
      }
      deps.agentSessionRepo.updateLifecycleState(childSession.id, "running");
      deps.agentSessionRepo.updateLifecycleState(parent.id, "waiting_child");
      deps.eventRepo.create({
        goalId: parent.goalId,
        runId: parent.runId,
        type: "agent.progress",
        message: "Worker delegation started.",
        data: {
          ...input.eventData,
          delegationControlEvent: undefined,
          runtimeEventType: "delegation.started",
          delegationRequestId: running.id,
          childSessionId: childSession.id,
          childProvider: input.providerId,
          childModel: input.modelLabel,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(childCwd.worktree ? { worktree: childCwd.worktree } : {}),
          ...(workerResult ? { workerDelegationRequestId: workerResult.id } : {}),
          ...(checkpoint ? { reviewMergeCheckpoint: checkpoint } : {}),
        },
      });
      deps.eventRepo.create({
        goalId: parent.goalId,
        runId: parent.runId,
        type: "agent.progress",
        message: "Supervisor waiting for worker result.",
        data: {
          ...input.eventData,
          delegationControlEvent: undefined,
          runtimeEventType: "delegation.waiting_child",
          delegationRequestId: running.id,
          childSessionId: childSession.id,
          childProvider: input.providerId,
          childModel: input.modelLabel,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(childCwd.worktree ? { worktree: childCwd.worktree } : {}),
          ...(workerResult ? { workerDelegationRequestId: workerResult.id } : {}),
          ...(checkpoint ? { reviewMergeCheckpoint: checkpoint } : {}),
        },
      });

      deps.activeHandles?.set(childSession.id, handle);
      // Fire-and-forget child consumption; any otherwise-unhandled rejection is
      // routed into the durable safety net so a failing child loop can never be
      // an unobserved promise rejection.
      void consumeChildEvents(deps, {
        events: handle.events(),
        delegationRequestId: running.id,
        childRunId: childRun.id,
        childSessionId: childSession.id,
        eventData: childEventData,
        parentSessionId: parent.id,
        role: input.role,
        taskId: input.taskId ?? null,
        workerTaskId: workerResult?.taskId ?? null,
        worktreePath: childCwd.path,
        pending: {},
        workerDelegationRequestId: workerResult?.id ?? null,
        integrationContext: input.integrationContext ?? null,
        reviewCandidateContext: input.reviewCandidateContext ?? null,
        frozenAcceptance: input.acceptance ?? workerResult?.acceptance ?? [],
        reviewMergeVerificationService,
        supervisorCwd,
        onChildOutcome: input.onChildOutcome,
      }).catch((err: unknown) => {
        recordUnhandledRuntimeFailure(
          { eventRepo: deps.eventRepo, agentSessionRepo: deps.agentSessionRepo },
          {
            kind: "delegation",
            goalId: parent.goalId,
            runId: parent.runId,
            delegationRequestId: running.id,
            childSessionId: childSession.id,
            error: err,
          },
        );
      }).finally(() => {
        deps.activeHandles?.delete(childSession.id);
      });
    },
  };
}

async function prepareReviewMerge(
  reviewMergeWorkspaceService: ReviewMergeWorkspaceService,
  supervisorCwd: string,
): Promise<AgentRuntimeReviewMergeCheckpoint> {
  const preparation = await reviewMergeWorkspaceService.prepareReviewMerge(supervisorCwd);
  if (!preparation.ok) {
    throw new Error(preparation.safeReason);
  }
  return preparation.checkpoint;
}

function childWorktreeMetadata(runId: string): AgentRuntimeWorktreeMetadata {
  return { path: "", label: `pending-${runId}` };
}

async function createWorkerCwd(
  worktreeService: WorktreeService,
  supervisorCwd: string,
  childSessionId: string,
  agentSessionRepo: AgentSessionRepository,
): Promise<{ path: string; worktree: AgentRuntimeWorktreeMetadata }> {
  const worktree = await worktreeService.createChildWorktree({
    parentCwd: supervisorCwd,
    childSessionId,
  });
  agentSessionRepo.updateSessionWorktree(childSessionId, worktree);
  return { path: worktree.path, worktree };
}

function requireWorkerResult(
  deps: DelegationCoordinatorDeps,
  parent: { id: string; goalId: string },
  workerDelegationRequestId?: string | null,
) {
  // Fresh supervisor continuations are new sessions, so the worker result the
  // review references may hang off an earlier supervisor session of the same
  // goal — search the whole lineage, not just the requesting session.
  const workerResult = deps.agentSessionRepo
    .listSessionsForGoal(parent.goalId)
    .flatMap((session) => deps.agentSessionRepo.listDelegationRequests(session.id))
    .find((request) => request.id === workerDelegationRequestId && request.role === "worker" && request.resultSummary);
  if (!workerResult?.resultSummary) {
    throw new Error("Review merge requires an existing worker result.");
  }
  return {
    id: workerResult.id,
    taskId: workerResult.taskId ?? null,
    resultSummary: workerResult.resultSummary,
    acceptance: workerResult.acceptance ?? null,
    worktreePath: workerResult.childSessionId
      ? deps.agentSessionRepo.getSession(workerResult.childSessionId)?.worktree?.path ?? null
      : null,
  };
}

interface ConsumeChildEventsInput extends Omit<RecordChildEventInput, "event"> {
  events: AsyncIterable<AgentRuntimeEvent>;
  role: AgentRuntimeDelegationRole;
  taskId: string | null;
  workerTaskId: string | null;
}

async function consumeChildEvents(deps: DelegationCoordinatorDeps, input: ConsumeChildEventsInput): Promise<void> {
  for await (const event of input.events) {
    const outcome = recordChildEvent(deps, { ...input, event });
    if (outcome) {
      if (!outcome.detached) {
        await input.onChildOutcome?.({
          parentSessionId: input.parentSessionId,
          delegationRequestId: input.delegationRequestId,
          childSessionId: input.childSessionId,
          observation: outcome.observation,
          role: input.role,
          taskId: input.taskId,
          workerTaskId: input.workerTaskId,
          worktreePath: input.worktreePath,
          resultSummary: outcome.resultSummary,
          reviewMergeOutcome: outcome.reviewMergeOutcome,
          reviewDecision: outcome.reviewDecision,
          reviewDecisionError: outcome.reviewDecisionError,
          integrationAttemptId: input.integrationContext?.integrationAttemptId ??
            input.reviewCandidateContext?.integrationAttemptId ?? null,
          reviewedCandidateCommitSha: input.reviewCandidateContext?.resolvedCandidateCommitSha ?? null,
          integrationResult: outcome.integrationResult,
          integrationResultError: outcome.integrationResultError,
          workerDelegationRequestId: input.workerDelegationRequestId,
        });
      }
      return;
    }
  }
}

interface RecordChildEventInput {
  event: AgentRuntimeEvent;
  delegationRequestId: string;
  childRunId: string;
  childSessionId: string;
  parentSessionId: string;
  eventData: Record<string, unknown>;
  worktreePath: string | null;
  /** Mutable per-child scratch: the latest structured result the child emitted. */
  pending: {
    taskResult?: ManagedTaskResult;
    reviewDecision?: ManagedReviewDecisionControlEvent;
    reviewDecisionError?: string;
    integrationResult?: ManagedIntegrationResultControlEvent;
    integrationResultError?: string;
  };
  role: AgentRuntimeDelegationRole;
  workerDelegationRequestId: string | null;
  integrationContext: StartWorkerDelegationInput["integrationContext"];
  reviewCandidateContext: StartWorkerDelegationInput["reviewCandidateContext"];
  frozenAcceptance: TaskAcceptanceCriterion[];
  reviewMergeVerificationService?: ReviewMergeVerificationService;
  supervisorCwd?: string;
  onChildOutcome?: (input: SupervisorContinuationInput) => Promise<void>;
}

interface ChildTerminalOutcome {
  observation: string;
  detached: boolean;
  resultSummary: AgentRuntimeDelegationSummary;
  reviewMergeOutcome: string | null;
  reviewDecision: ManagedReviewDecisionControlEvent | null;
  reviewDecisionError: string | null;
  integrationResult: ManagedIntegrationResultControlEvent | null;
  integrationResultError: string | null;
}

function recordChildEvent(deps: DelegationCoordinatorDeps, input: RecordChildEventInput): ChildTerminalOutcome | null {
  const terminalKinds = {
    "session.completed": { status: "completed", kind: "success", childState: "completed", runStatus: "completed" },
    "session.failed": { status: "failed", kind: "failure", childState: "failed", runStatus: "failed" },
    "session.cancelled": { status: "cancelled", kind: "cancelled", childState: "cancelled", runStatus: "failed" },
    "session.timed_out": { status: "timed_out", kind: "timeout", childState: "failed", runStatus: "failed" },
  } as const;
  const terminal = terminalKinds[input.event.type as keyof typeof terminalKinds];
  if (terminal) {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.childSessionId, terminal.childState);
    deps.runRepo.updateStatus(input.childRunId, terminal.runStatus, {
      finishedAt,
      ...(terminal.runStatus === "failed" ? { error: input.event.message } : {}),
    });
    const request = recordTerminalDelegation(
      deps,
      input,
      terminal.status,
      buildTerminalSummary(deps, input, terminal.kind),
    );
    recordReviewMergeApplyOutcome(deps, input, request.id);
    recordDelegationOutcome(
      deps,
      input,
      request.id,
      request.status === "detached" ? "delegation.detached" : `delegation.${terminal.status}`,
      input.event.message,
    );
    return {
      observation: input.event.message,
      detached: request.status === "detached",
      resultSummary: request.resultSummary ?? summary(terminal.kind, input.event.message),
      reviewMergeOutcome: isReviewMergeApplyOutcome(input.event.metadata?.reviewMergeApplyOutcome)
        ? input.event.metadata.reviewMergeApplyOutcome.status
        : null,
      reviewDecision: input.pending.reviewDecision ?? null,
      reviewDecisionError: input.pending.reviewDecisionError ?? null,
      integrationResult: input.pending.integrationResult ?? null,
      integrationResultError: input.pending.integrationResultError ??
        (input.role === "integrator" && !input.pending.integrationResult
          ? "Integrator completed without a managed_integration.result block."
          : null),
    };
  }

  if (input.event.metadata?.delegationControlEvent !== undefined) {
    if (input.role === "integrator" && input.integrationContext) {
      if (input.pending.integrationResult) {
        input.pending.integrationResultError = "Integrator emitted more than one managed_integration.result block.";
        return null;
      }
      const integrated = validateManagedIntegrationResult({
        controlEvent: input.event.metadata.delegationControlEvent,
        expectedIntegrationAttemptId: input.integrationContext.integrationAttemptId,
        expectedWorkerDelegationRequestId: input.integrationContext.workerDelegationRequestId,
        expectedOriginalCandidateCommitSha: input.integrationContext.originalCandidateCommitSha,
      });
      if (integrated.ok) {
        input.pending.integrationResult = integrated.result;
        input.pending.integrationResultError = undefined;
      } else {
        input.pending.integrationResultError = integrated.safeReason;
      }
      return null;
    }
    if (input.role === "review_merge" && input.workerDelegationRequestId) {
      const reviewed = validateManagedReviewDecision({
        controlEvent: input.event.metadata.delegationControlEvent,
        expectedWorkerDelegationRequestId: input.workerDelegationRequestId,
        expectedIntegrationAttemptId: input.reviewCandidateContext?.integrationAttemptId ?? null,
        expectedReviewedCandidateCommitSha: input.reviewCandidateContext?.resolvedCandidateCommitSha ?? null,
        frozenCriteria: input.frozenAcceptance,
      });
      if (reviewed.ok) {
        input.pending.reviewDecision = reviewed.decision;
        input.pending.reviewDecisionError = undefined;
      } else {
        input.pending.reviewDecisionError = reviewed.safeReason;
      }
      return null;
    }
    const parsed = validateManagedTaskResult(input.event.metadata.delegationControlEvent);
    if (parsed.ok) {
      input.pending.taskResult = parsed.result;
      deps.eventRepo.create({
        goalId: input.event.goalId,
        runId: input.event.runId,
        type: "agent.progress",
        message: "Child task result received.",
        data: {
          ...input.eventData,
          delegationControlEvent: undefined,
          runtimeEventType: "task.result",
          childSessionId: input.childSessionId,
          taskResult: parsed.result,
        },
      });
      return null;
    }
    deps.eventRepo.create({
      goalId: input.event.goalId,
      runId: input.event.runId,
      type: "agent.progress",
      message: "Child control block ignored.",
      data: {
        ...input.eventData,
        delegationControlEvent: undefined,
        runtimeEventType: "child_control.ignored",
        childSessionId: input.childSessionId,
        safeReason: parsed.safeReason,
      },
    });
    return null;
  }

  deps.eventRepo.create({
    goalId: input.event.goalId,
    runId: input.event.runId,
    type: "agent.progress",
    message: input.event.message,
    data: {
      ...input.eventData,
      runtimeEventType: input.event.type,
      childSessionId: input.childSessionId,
    },
  });
  return null;
}

/** Merge the child's structured result and backend attestation into the terminal summary. */
function buildTerminalSummary(
  deps: DelegationCoordinatorDeps,
  input: RecordChildEventInput,
  kind: AgentRuntimeDelegationSummary["kind"],
): AgentRuntimeDelegationSummary {
  const base = summary(kind, input.event.message);
  const structured = input.pending.taskResult;
  if (structured) {
    if (structured.criterionEvidence.length > 0) base.criterionEvidence = structured.criterionEvidence;
    if (structured.tests.length > 0) base.tests = structured.tests;
    if (structured.claimedFiles.length > 0) base.claimedFiles = structured.claimedFiles;
  }
  if (input.worktreePath) {
    const attestor = deps.worktreeAttestor ?? attestWorktreeFiles;
    const attestedFiles = attestor(input.worktreePath).sort();
    base.attestedFiles = attestedFiles;
    if (structured && structured.claimedFiles.length > 0) {
      const claimed = [...structured.claimedFiles].sort();
      base.filesDiscrepancy =
        claimed.length !== attestedFiles.length ||
        claimed.some((path, index) => path !== attestedFiles[index]);
    }
  }
  return base;
}

function recordReviewMergeApplyOutcome(
  deps: DelegationCoordinatorDeps,
  input: RecordChildEventInput,
  delegationRequestId: string,
): void {
  const outcome = input.event.metadata?.reviewMergeApplyOutcome;
  if (!isReviewMergeApplyOutcome(outcome)) return;
  const checkpoint = isReviewMergeCheckpoint(input.eventData.reviewMergeCheckpoint)
    ? input.eventData.reviewMergeCheckpoint
    : null;
  const verification =
    outcome.status === "merged" && checkpoint && input.reviewMergeVerificationService
      ? input.reviewMergeVerificationService.verifyMerged({
          cwd: input.supervisorCwd ?? process.cwd(),
          checkpoint,
        })
      : null;
  const finalOutcome = verification?.outcome ?? outcome.status;

  deps.eventRepo.create({
    goalId: input.event.goalId,
    runId: input.event.runId,
    type: "agent.progress",
    message: verification?.safeSummary ?? outcome.safeSummary ?? `Review merge outcome: ${outcome.status}.`,
    data: {
      ...input.eventData,
      runtimeEventType: "review_merge.apply_outcome",
      delegationRequestId,
      childSessionId: input.childSessionId,
      reviewMergeOutcome: finalOutcome,
      diffSummary: outcome.diffSummary ?? null,
      safeSummary: verification?.safeSummary ?? outcome.safeSummary ?? null,
      fixedTest: verification?.fixedTest ?? null,
      revertEvidence: verification?.revertEvidence ?? null,
    },
  });
}

function isReviewMergeApplyOutcome(value: unknown): value is AgentRuntimeReviewMergeApplyOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.status === "merged" ||
      record.status === "rejected" ||
      record.status === "conflict" ||
      record.status === "test_failed_reverted" ||
      record.status === "revert_failed" ||
      record.status === "failed" ||
      record.status === "verification_failed") &&
    (record.diffSummary === undefined || record.diffSummary === null || typeof record.diffSummary === "string") &&
    (record.safeSummary === undefined || record.safeSummary === null || typeof record.safeSummary === "string")
  );
}

function isReviewMergeCheckpoint(value: unknown): value is AgentRuntimeReviewMergeCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.head === "string" && typeof record.statusSummary === "string";
}

function recordTerminalDelegation(
  deps: DelegationCoordinatorDeps,
  input: RecordChildEventInput,
  status: "completed" | "failed" | "cancelled" | "timed_out",
  result: AgentRuntimeDelegationSummary,
) {
  const parent = deps.agentSessionRepo.getSession(input.parentSessionId);
  if (parent && ["cancelled", "failed", "completed"].includes(parent.lifecycleState)) {
    return deps.agentSessionRepo.detachDelegationRequest(
      input.delegationRequestId,
      result,
      "Supervisor is terminal; child result stored as detached.",
    );
  }
  if (status === "completed") return deps.agentSessionRepo.completeDelegationRequest(input.delegationRequestId, result);
  if (status === "failed") return deps.agentSessionRepo.failDelegationRequest(input.delegationRequestId, result);
  if (status === "cancelled") return deps.agentSessionRepo.cancelDelegationRequest(input.delegationRequestId, result);
  return deps.agentSessionRepo.timeOutDelegationRequest(input.delegationRequestId, result);
}

function recordDelegationOutcome(
  deps: DelegationCoordinatorDeps,
  input: RecordChildEventInput,
  delegationRequestId: string,
  runtimeEventType: string,
  message: string,
): void {
  deps.eventRepo.create({
    goalId: input.event.goalId,
    runId: input.event.runId,
    type: "agent.progress",
    message,
    data: {
      ...input.eventData,
      runtimeEventType,
      delegationRequestId,
      childSessionId: input.childSessionId,
    },
  });
}

function summary(kind: AgentRuntimeDelegationSummary["kind"], safeSummary: string): AgentRuntimeDelegationSummary {
  return { kind, safeSummary };
}
