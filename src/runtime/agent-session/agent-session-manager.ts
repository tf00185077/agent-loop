import { existsSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type {
  AgentAssignableRole,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeSession,
  AgentSessionHandle,
  GoalInputBudgetName,
  GoalInputRequest,
  GoalInputRequestReason,
  GoalInputResponse,
  GoalReassessment,
  ManagedCompletionGap,
  ReassessmentGap,
} from "../../domain/index.js";
import { allowedDecisionsForReason } from "../../domain/index.js";
import { validateGoalInputResponse } from "./goal-input-response.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type { GoalInputRequestRepository } from "../../persistence/goal-input-request-repository.js";
import type { AppDatabase } from "../../persistence/database.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import {
  createManagedChangeArchiveRepository,
  type ManagedChangeArchiveRepository,
} from "../../persistence/managed-change-archive-repository.js";
import type {
  AgentSessionRepository,
  EventRepository,
  RunRepository,
} from "../../persistence/runtime-repositories.js";
import { GoalChangeRegistry, specTaskAcceptance, specTaskId, specValidationVerdict } from "./change-registry.js";
import { createDelegationCoordinator, type SupervisorContinuationInput } from "./delegation-coordinator.js";
import { validateManagedControlEvent } from "./delegation-control-event.js";
import { evaluateManagedCompletion } from "./managed-completion-evaluator.js";
import {
  evaluateDurableManagedTaskLineage,
  lineageGapsForChange,
} from "./managed-task-lineage.js";
import {
  createManagedDeliveryService,
  type ManagedDeliveryResult,
  type ManagedDeliveryService,
} from "./managed-delivery-service.js";
import { createManagedIntegrationService, type ManagedIntegrationService } from "./managed-integration-service.js";
import { projectManagedTaskContext } from "./managed-context-projection.js";
import { rehydrateChangeRegistry, rehydrateTaskRegistry } from "./supervisor-state-rehydration.js";
import {
  createOpenSpecWorkspaceService,
  type OpenSpecWorkspaceService,
} from "./openspec-workspace-service.js";
import { buildIntegratorContractAppendix, buildSpecWriterAppendix, buildSupervisorPrompt } from "./supervisor-prompt.js";
import { GoalTaskRegistry } from "./task-registry.js";
import { buildSpecReviewPacket } from "./spec-review-packet.js";
import { createShellCheckRunner, DEFAULT_CHECK_TIMEOUT_MS, type CheckRunner } from "./check-runner.js";
import type { ReviewMergeVerificationService } from "./review-merge-verification-service.js";
import type { ReviewMergeWorkspaceService } from "./review-merge-workspace-service.js";
import { createGitWorktreeService, type WorktreeAttestor, type WorktreeService } from "./worktree-service.js";

export interface AgentSessionManagerDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  eventRepo: EventRepository;
  agentSessionRepo: AgentSessionRepository;
  database?: AppDatabase;
  managedTaskRepo?: ManagedTaskRepository;
  managedDeliveryService?: ManagedDeliveryService;
  managedIntegrationService?: ManagedIntegrationService;
  worktreeService?: WorktreeService;
  worktreeAttestor?: WorktreeAttestor;
  /** Executes acceptance checks; defaults to the shell runner. */
  checkRunner?: CheckRunner;
  openSpecWorkspaceService?: OpenSpecWorkspaceService;
  reviewMergeWorkspaceService?: ReviewMergeWorkspaceService;
  reviewMergeVerificationService?: ReviewMergeVerificationService;
  managedChangeArchiveRepo?: ManagedChangeArchiveRepository;
  /**
   * Durable ledger for goal-level caller escalation. When absent the
   * recoverable bound decisions degrade visibly to the legacy terminal
   * `blocked` behavior instead of waiting for caller input.
   */
  goalInputRequestRepo?: GoalInputRequestRepository;
  /** Test-only fault windows around non-transactional archive boundaries. */
  archiveFault?: (point: "after_intent" | "after_move" | "after_final_event") => void;
  supervisorCwd?: string;
  /**
   * Maximum supervisor continuations started because a delegation-capable
   * session ended without successfully completing, per goal.
   */
  maxSupervisorContinuations?: number;
  /**
   * Maximum planning epochs per goal; an unsatisfied reassessment beyond this
   * budget blocks the goal instead of opening another epoch.
   */
  maxPlanningEpochs?: number;
  /**
   * Resolves user-configured role→agent assignments for child dispatch.
   * Returning null keeps the goal's default adapter.
   */
  roleAdapterResolver?: (role: AgentAssignableRole) => ResolvedRoleAgentLike | null;
}

export interface ResolvedRoleAgentLike {
  adapter: AgentRuntimeAdapter;
  providerId: string;
  modelLabel: string | null;
}

export interface StartManagedSessionInput {
  goalId: string;
  providerId: string;
  modelLabel: string | null;
  /** Session prompt override; when omitted the supervisor bootstrap prompt is built from the goal. */
  prompt?: string;
  /** Provider-native session id to resume (Phase 4b); the adapter ignores it when resume is unsupported. */
  resumeSessionId?: string | null;
  adapter: AgentRuntimeAdapter;
}

export interface ResumeInterruptedGoalInput {
  goalId: string;
  providerId: string;
  modelLabel: string | null;
  adapter: AgentRuntimeAdapter;
}

export interface StartManagedSessionResult {
  session: AgentRuntimeSession;
}

export interface RespondToGoalInputRequestInput {
  goalId: string;
  requestId: string;
  /** Raw caller response body; validated deterministically before any effect. */
  body: unknown;
  /**
   * Adapter bundle used to restart the supervisor for resume decisions. When
   * absent, an accepted resume decision defers visibly: the goal is left
   * `interrupted` so the next boot's recovery resumes it.
   */
  runtime?: { providerId: string; modelLabel: string | null; adapter: AgentRuntimeAdapter };
}

export type RespondToGoalInputRequestResult =
  | { ok: true; request: GoalInputRequest; outcome: "resumed" | "resume_deferred" | "abandoned" }
  | { ok: false; code: "not_found" | "conflict" | "invalid"; safeReason: string; standing?: GoalInputRequest };

export interface AgentSessionManager {
  startManagedSession(input: StartManagedSessionInput): Promise<StartManagedSessionResult>;
  recoverOrphanedSessions(): AgentRuntimeSession[];
  reconcileOrphanedWorktrees(): Promise<void>;
  resumeInterruptedGoal(input: ResumeInterruptedGoalInput): Promise<void>;
  respondToGoalInputRequest(input: RespondToGoalInputRequestInput): Promise<RespondToGoalInputRequestResult>;
  approve(sessionId: string, requestId: string): Promise<boolean>;
  reject(sessionId: string, requestId: string, reason?: string): Promise<boolean>;
  cancel(sessionId: string, reason?: string): Promise<boolean>;
}

class PostCommitCacheRefreshInterruption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostCommitCacheRefreshInterruption";
  }
}

export function createAgentSessionManager(deps: AgentSessionManagerDeps): AgentSessionManager {
  const activeHandles = new Map<string, AgentSessionHandle>();
  const deliveredControls = new Set<string>();
  const runtimeCommandIds = new Map<string, string>();
  const state: SupervisorState = {
    completedGoals: new Set(),
    completionlessContinuations: new Map(),
    lastRejectionReasons: new Map(),
    completionRequestsEvaluated: new Set(),
    lastCompletionGaps: new Map(),
    taskRegistries: new Map(),
    changeRegistries: new Map(),
    openspecDowngradeReported: new Set(),
    roleResolutions: new Map(),
    maxSupervisorContinuations: deps.maxSupervisorContinuations ?? 10,
    maxPlanningEpochs: deps.maxPlanningEpochs ?? 5,
    openSpec: deps.openSpecWorkspaceService ?? createOpenSpecWorkspaceService(),
    supervisorCwd: deps.supervisorCwd ?? process.cwd(),
  };

  const manager: AgentSessionManager = {
    async startManagedSession(input) {
      const goal = deps.goalRepo.getById(input.goalId);
      if (!goal) throw new Error(`Goal not found: ${input.goalId}`);

      const capabilities = await input.adapter.detectCapabilities();
      const run = deps.runRepo.create({
        goalId: goal.id,
        provider: input.providerId,
        model: input.modelLabel ?? "unknown",
      });
      const session = deps.agentSessionRepo.createSession({
        goalId: goal.id,
        runId: run.id,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        lifecycleState: "starting",
        capabilities,
      });

      deps.eventRepo.create({
        goalId: goal.id,
        runId: run.id,
        type: "run.started",
        message: "Managed agent session started",
        data: {
          runId: run.id,
          sessionId: session.id,
          provider: input.providerId,
          model: input.modelLabel,
        },
      });

      const handle = await input.adapter.startSession({
        sessionId: session.id,
        goalId: goal.id,
        runId: run.id,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        prompt: input.prompt ?? buildSupervisorPrompt({ goal, phase: { kind: "bootstrap" } }),
        resumeSessionId: input.resumeSessionId ?? null,
      });
      activeHandles.set(session.id, handle);
      deps.agentSessionRepo.updateLifecycleState(session.id, "running");

      await runSessionEvents(deps, {
        handle,
        goalId: goal.id,
        runId: run.id,
        sessionId: session.id,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        adapter: input.adapter,
        activeHandles,
        runtimeCommandIds,
        state,
      });

      return { session: deps.agentSessionRepo.getSession(session.id)! };
    },

    recoverOrphanedSessions() {
      const recovered: AgentRuntimeSession[] = [];
      const reconciledGoals = new Set<string>();
      const worktreeService = deps.worktreeService ?? createGitWorktreeService();
      const deliveryService = deps.managedDeliveryService ?? createManagedDeliveryService();
      for (const session of deps.agentSessionRepo.listNonTerminalSessions()) {
        // The adapter process is gone; this session and its run attempt are over.
        const stalled = deps.agentSessionRepo.updateLifecycleState(session.id, "stalled");
        deps.runRepo.updateStatus(session.runId, "failed", {
          finishedAt: new Date().toISOString(),
          error: "Managed agent session lost adapter control.",
        });
        recovered.push(stalled);
        // Reconcile each goal once into a clean, resumable `interrupted` state
        // instead of force-failing it. Skip goals already reconciled (idempotent
        // across restarts) or already terminal.
        if (reconciledGoals.has(session.goalId)) continue;
        reconciledGoals.add(session.goalId);
        const goal = deps.goalRepo.getById(session.goalId);
        // waiting_user is stable: a goal parked on a pending caller input
        // request keeps waiting across restarts instead of being reconciled
        // into interrupted recovery.
        if (goal && ["interrupted", "completed", "failed", "blocked", "cancelled", "waiting_user"].includes(goal.status)) continue;
        reconcileInterruptedGoal(deps, deliveryService, worktreeService, state, session);
      }

      return recovered;
    },

    async reconcileOrphanedWorktrees() {
      const worktreeService = deps.worktreeService ?? createGitWorktreeService();
      for (const record of deps.agentSessionRepo.listWorktreesForTerminalGoals()) {
        const path = record.worktree?.path;
        if (!path) continue;
        try {
          await worktreeService.removeWorktree({ parentCwd: state.supervisorCwd, path });
          deps.eventRepo.create({
            goalId: record.goalId,
            type: "agent.progress",
            message: "Reclaimed orphaned worker worktree.",
            data: {
              runtimeEventType: "worktree.reclaimed",
              sessionId: record.sessionId,
              worktreeLabel: record.worktree.label,
            },
          });
        } catch (error) {
          deps.eventRepo.create({
            goalId: record.goalId,
            type: "agent.progress",
            message: "Failed to reclaim orphaned worker worktree.",
            data: {
              runtimeEventType: "worktree.reclaim_failed",
              sessionId: record.sessionId,
              worktreeLabel: record.worktree.label,
              safeReason: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    },

    async resumeInterruptedGoal(input) {
      const goal = deps.goalRepo.getById(input.goalId);
      if (!goal || goal.status !== "interrupted") return;
      await resumeGoalFromDurableProjection(input, {
        observation: "Resumed after backend restart.",
        resumedEventMessage: "Interrupted goal resumed from durable projection.",
        resumedRuntimeEventType: "recovery.resumed",
      });
    },

    async respondToGoalInputRequest(input) {
      const repo = deps.goalInputRequestRepo;
      if (!repo) {
        return { ok: false, code: "not_found", safeReason: "Goal escalation is unavailable on this backend." };
      }
      const request = repo.getById(input.requestId);
      if (!request || request.goalId !== input.goalId) {
        return { ok: false, code: "not_found", safeReason: "Input request not found for this goal." };
      }
      if (request.status !== "pending") {
        return {
          ok: false,
          code: "conflict",
          safeReason: `Input request already resolved: ${request.status}.`,
          standing: request,
        };
      }
      const goal = deps.goalRepo.getById(input.goalId);
      if (!goal || goal.status !== "waiting_user") {
        return {
          ok: false,
          code: "conflict",
          safeReason: `Goal is ${goal?.status ?? "missing"}, not waiting for caller input.`,
          standing: request,
        };
      }

      const base = request.payload.budgetName === "planning_epochs"
        ? state.maxPlanningEpochs
        : state.maxSupervisorContinuations;
      const validation = validateGoalInputResponse(request, input.body, base);
      if (!validation.ok) {
        deps.eventRepo.create({
          goalId: input.goalId,
          type: "goal.input_response",
          message: "Caller response rejected.",
          data: {
            runtimeEventType: "goal.input_response_rejected",
            inputRequestId: request.id,
            safeReason: validation.safeReason,
          },
        });
        return { ok: false, code: "invalid", safeReason: validation.safeReason };
      }
      const response = validation.response;

      if (response.decision === "abandon") {
        const resolved = repo.resolve(request.id, "abandoned", response);
        deps.eventRepo.create({
          goalId: input.goalId,
          type: "goal.input_response",
          message: "Caller abandoned the goal.",
          data: {
            runtimeEventType: "goal.input_response_accepted",
            inputRequestId: request.id,
            decision: "abandon",
            ...(response.reason ? { reason: response.reason } : {}),
          },
        });
        deps.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: new Date().toISOString() });
        deps.eventRepo.create({
          goalId: input.goalId,
          type: "goal.blocked",
          message: "Goal blocked: the caller chose to abandon after escalation.",
          data: {
            runtimeEventType: "goal.abandoned_by_caller",
            inputRequestId: request.id,
            reasonCode: request.reasonCode,
            ...(response.reason ? { reason: response.reason } : {}),
          },
        });
        return { ok: true, request: resolved, outcome: "abandoned" };
      }

      const resolved = repo.resolve(request.id, "accepted", response);
      // Supervisor questions carry no budget; skip the effective-budget math.
      const budgetName = request.payload.budgetName;
      const effective = budgetName ? effectiveBudget(deps, state, input.goalId, budgetName) : null;
      const label = budgetName ? budgetLabel(budgetName) : null;
      deps.eventRepo.create({
        goalId: input.goalId,
        type: "goal.input_response",
        message: response.decision === "extend_budget"
          ? `Caller granted ${response.extension} additional ${label} (effective budget ${effective}).`
          : request.reasonCode === "supervisor_question"
            ? "Caller answered the supervisor's question."
            : "Caller provided guidance for the resumed supervisor.",
        data: {
          runtimeEventType: "goal.input_response_accepted",
          inputRequestId: request.id,
          decision: response.decision,
          ...(budgetName ? { budgetName, effectiveBudget: effective } : {}),
          ...(response.decision === "extend_budget"
            ? { extension: response.extension }
            : { guidance: response.guidance }),
        },
      });

      if (!input.runtime) {
        // Degrade visibly: without an adapter the grant is durable but the
        // restart is deferred to the interrupted-goal recovery on next boot.
        deps.goalRepo.updateStatus(input.goalId, "interrupted");
        deps.eventRepo.create({
          goalId: input.goalId,
          type: "agent.progress",
          message: "Caller response accepted; resume deferred until a provider adapter is available.",
          data: { runtimeEventType: "escalation.resume_deferred", inputRequestId: request.id },
        });
        return { ok: true, request: resolved, outcome: "resume_deferred" };
      }

      await resumeGoalFromDurableProjection(
        {
          goalId: input.goalId,
          providerId: input.runtime.providerId,
          modelLabel: input.runtime.modelLabel,
          adapter: input.runtime.adapter,
        },
        {
          observation: renderCallerObservation(request, response, label, effective),
          resumedEventMessage: "Goal resumed after caller input.",
          resumedRuntimeEventType: "escalation.resumed",
          extraEventData: { inputRequestId: request.id },
        },
      );
      return { ok: true, request: resolved, outcome: "resumed" };
    },

    approve(sessionId, requestId) {
      return deliverControl(activeHandles, deliveredControls, sessionId, `approve:${requestId}`, (handle) =>
        handle.approve(requestId),
      );
    },

    reject(sessionId, requestId, reason) {
      return deliverControl(activeHandles, deliveredControls, sessionId, `reject:${requestId}`, (handle) =>
        handle.reject(requestId, reason),
      );
    },

    async cancel(sessionId, reason) {
      // Cancel in-flight descendants first: an orphaned child session keeps
      // its provider process running (and consuming quota) otherwise.
      for (const childSessionId of listActiveDescendantSessionIds(deps, activeHandles, sessionId)) {
        await deliverControl(activeHandles, deliveredControls, childSessionId, "cancel", (handle) =>
          handle.cancel(reason),
        );
      }
      const delivered = await deliverControl(activeHandles, deliveredControls, sessionId, "cancel", (handle) =>
        handle.cancel(reason),
      );
      // A waiting_user goal has no live handle to cancel through; resolve its
      // pending input request and close the goal out directly.
      const session = deps.agentSessionRepo.getSession(sessionId);
      const goal = session ? deps.goalRepo.getById(session.goalId) : null;
      if (goal?.status === "waiting_user" && deps.goalInputRequestRepo) {
        const pending = deps.goalInputRequestRepo.getPending(goal.id);
        if (pending) deps.goalInputRequestRepo.resolve(pending.id, "cancelled", null);
        deps.goalRepo.updateStatus(goal.id, "cancelled", { completedAt: new Date().toISOString() });
        deps.eventRepo.create({
          goalId: goal.id,
          type: "agent.progress",
          message: "Waiting goal cancelled; pending input request resolved.",
          data: {
            runtimeEventType: "escalation.cancelled",
            ...(pending ? { inputRequestId: pending.id } : {}),
            ...(reason ? { safeReason: reason } : {}),
          },
        });
      }
      return delivered;
    },
  };

  /**
   * Cold-path resume shared by restart recovery and caller-escalation resume:
   * rehydrate the working caches from the durable ledger, rebuild the
   * continuation prompt around the given observation, and start a fresh
   * supervisor session. On failure the goal reverts to the visible
   * `interrupted` state so a later boot can pick it up.
   */
  async function resumeGoalFromDurableProjection(
    input: ResumeInterruptedGoalInput,
    resume: {
      observation: string;
      resumedEventMessage: string;
      resumedRuntimeEventType: string;
      extraEventData?: Record<string, unknown>;
    },
  ): Promise<void> {
    const goal = deps.goalRepo.getById(input.goalId);
    if (!goal) return;

    if (deps.managedTaskRepo) {
      rehydrateTaskRegistry(getTaskRegistry(state, input.goalId), deps.managedTaskRepo, input.goalId);
      rehydrateChangeRegistry(
        getChangeRegistry(state, input.goalId),
        deps.managedTaskRepo,
        input.goalId,
        deps.eventRepo.listForGoal(input.goalId),
      );
    }
    if (deps.database && !reconcileDurableArchivesBeforeResume(deps, state, input.goalId)) return;

    const continuationPrompt = buildSupervisorPrompt({
      goal,
      phase: { kind: "continuation", observation: resume.observation },
      taskHistory: getTaskRegistry(state, input.goalId).listTasks(),
      managedTaskContext: deps.managedTaskRepo
        ? projectManagedTaskContext(deps.managedTaskRepo, input.goalId)
        : undefined,
      changeHistory: getChangeRegistry(state, input.goalId).listChanges(),
      epochHistory: getChangeRegistry(state, input.goalId).listEpochs(),
    });

    // The most recent persisted provider session id, if any, lets the adapter
    // replay the prior transcript (Phase 4b); it falls back to fresh when the
    // provider does not support resume.
    const resumeSessionId = deps.agentSessionRepo
      .listSessionsForGoal(input.goalId)
      .reverse()
      .find((session) => session.providerSessionId)?.providerSessionId ?? null;

    deps.goalRepo.updateStatus(input.goalId, "running");
    deps.eventRepo.create({
      goalId: input.goalId,
      type: "agent.progress",
      message: resume.resumedEventMessage,
      data: {
        runtimeEventType: resume.resumedRuntimeEventType,
        provider: input.providerId,
        model: input.modelLabel,
        providerResume: Boolean(resumeSessionId),
        ...resume.extraEventData,
      },
    });

    try {
      await manager.startManagedSession({
        goalId: input.goalId,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        adapter: input.adapter,
        prompt: continuationPrompt,
        resumeSessionId,
      });
    } catch (error) {
      // Best-effort: a resume that cannot start must not spin. Revert to the
      // visible interrupted state so a later boot can reconcile and resume.
      deps.goalRepo.updateStatus(input.goalId, "interrupted");
      deps.eventRepo.create({
        goalId: input.goalId,
        type: "agent.progress",
        message: "Resume failed to start; goal left interrupted for a later boot.",
        data: {
          runtimeEventType: "recovery.resume_failed",
          safeReason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return manager;
}

/** Human-readable name of a goal-level budget for observations and events. */
function budgetLabel(name: GoalInputBudgetName): string {
  return name === "planning_epochs" ? "planning epochs" : "supervisor continuations";
}

/**
 * Deterministic rendering of an accepted caller decision, injected into the
 * resumed supervisor's continuation prompt as an observation. Guidance is
 * information for the supervisor; every deterministic gate still applies.
 * Question answers carry both sides so the fresh continuation needs no
 * event-timeline archaeology.
 */
function renderCallerObservation(
  request: GoalInputRequest,
  response: Extract<GoalInputResponse, { decision: "extend_budget" | "provide_guidance" }>,
  label: string | null,
  effective: number | null,
): string {
  if (response.decision === "extend_budget") {
    return `Caller input: granted additional ${label}; the effective budget is now ${effective}. ` +
      "Continue the goal within the extended bound.";
  }
  if (request.reasonCode === "supervisor_question") {
    return `Caller answered the supervisor's question. Q: ${request.safeSummary} A: ${response.guidance}`;
  }
  return `Caller input: guidance for continuing — ${response.guidance}`;
}

/**
 * Effective goal-level budget: the configured base plus every accepted caller
 * grant, recomputed from durable rows so restarts cannot lose an extension.
 */
function effectiveBudget(
  deps: AgentSessionManagerDeps,
  state: SupervisorState,
  goalId: string,
  budgetName: GoalInputBudgetName,
): number {
  const base = budgetName === "planning_epochs" ? state.maxPlanningEpochs : state.maxSupervisorContinuations;
  return base + (deps.goalInputRequestRepo?.sumAcceptedExtensions(goalId, budgetName) ?? 0);
}

/**
 * Depth-first list of a session's descendant session ids that still hold a
 * live handle, deepest first so leaves cancel before their parents.
 */
function listActiveDescendantSessionIds(
  deps: AgentSessionManagerDeps,
  activeHandles: Map<string, AgentSessionHandle>,
  sessionId: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(sessionId)) return [];
  seen.add(sessionId);
  const descendants: string[] = [];
  for (const request of deps.agentSessionRepo.listDelegationRequests(sessionId)) {
    const childSessionId = request.childSessionId;
    if (!childSessionId || seen.has(childSessionId)) continue;
    descendants.push(...listActiveDescendantSessionIds(deps, activeHandles, childSessionId, seen));
    if (activeHandles.has(childSessionId)) descendants.push(childSessionId);
  }
  return descendants;
}

async function deliverControl(
  activeHandles: Map<string, AgentSessionHandle>,
  deliveredControls: Set<string>,
  sessionId: string,
  controlKey: string,
  deliver: (handle: AgentSessionHandle) => Promise<void>,
): Promise<boolean> {
  const key = `${sessionId}:${controlKey}`;
  const handle = activeHandles.get(sessionId);
  if (!handle || deliveredControls.has(key)) {
    return false;
  }

  deliveredControls.add(key);
  await deliver(handle);
  return true;
}

/**
 * Reconcile one restart-interrupted goal into a clean, resumable `interrupted`
 * state (Phase 3a): reset pending deliveries to their recorded checkpoint,
 * interrupt in-flight worker attempts and reset their tasks, discard their
 * worktrees, interrupt non-terminal integrations, and record durable evidence.
 * Does not resume execution — that is Phase 3b.
 */
function reconcileInterruptedGoal(
  deps: AgentSessionManagerDeps,
  deliveryService: ManagedDeliveryService,
  worktreeService: WorktreeService,
  state: SupervisorState,
  session: AgentRuntimeSession,
): void {
  const { goalId, runId } = session;
  let deliveriesReset = 0;
  let attemptsInterrupted = 0;
  let tasksReset = 0;
  const blockPendingDeliveryRecovery = (
    deliveryId: string,
    blockerType: string,
    safeReason: string,
  ): void => {
    const finishedAt = new Date().toISOString();
    deps.goalRepo.updateStatus(goalId, "blocked", { completedAt: finishedAt });
    deps.eventRepo.create({
      goalId,
      runId,
      type: "agent.progress",
      message: "Restart recovery blocked because a pending delivery could not be reset safely.",
      data: {
        runtimeEventType: "recovery.reconciliation_blocked",
        sessionId: session.id,
        blockerType,
        deliveryId,
        safeReason,
        recoveryState: "blocked",
      },
    });
  };

  // 1. Reset every pending delivery to its recorded clean checkpoint so git and
  //    the ledger agree and no candidate is double-applied or left unvalidated.
  for (const delivery of deps.managedTaskRepo?.listPendingDeliveries(goalId) ?? []) {
    if (!delivery.checkpointHead) {
      blockPendingDeliveryRecovery(
        delivery.id,
        "pending_delivery_checkpoint_missing",
        "Pending delivery has no recorded clean checkpoint for restart reconciliation.",
      );
      return;
    }
    if (!deliveryService.reconcilePendingDelivery) {
      blockPendingDeliveryRecovery(
        delivery.id,
        "pending_delivery_reconciler_unavailable",
        "Pending delivery reconciliation is unavailable during restart recovery.",
      );
      return;
    }
    const reconciled = deliveryService.reconcilePendingDelivery({
      supervisorCwd: state.supervisorCwd,
      checkpointHead: delivery.checkpointHead,
    });
    if (reconciled.status === "reset_failed") {
      const safeReason = sanitizeArchiveReason(reconciled.safeSummary, state.supervisorCwd);
      blockPendingDeliveryRecovery(delivery.id, "pending_delivery_reset_failed", safeReason);
      return;
    }
    deliveriesReset += 1;
  }

  // 2. Interrupt in-flight worker attempts, reset their tasks for re-dispatch,
  //    and discard their (never-committed) worktrees.
  for (const attempt of deps.agentSessionRepo.listInFlightWorkerAttemptsForGoal(goalId)) {
    deps.agentSessionRepo.detachDelegationRequest(
      attempt.delegationRequestId,
      { kind: "cancelled", safeSummary: "Worker attempt interrupted for restart recovery." },
      "Worker attempt interrupted because backend adapter control was lost during restart.",
    );
    attemptsInterrupted += 1;
    if (attempt.taskId && deps.managedTaskRepo?.getTask(goalId, attempt.taskId)) {
      deps.managedTaskRepo.resetTaskForReDispatch(attempt.taskId, runId, goalId);
      tasksReset += 1;
    }
    const path = attempt.worktree?.path;
    if (path) void worktreeService.removeWorktree({ parentCwd: state.supervisorCwd, path }).catch(() => undefined);
  }

  // 3. Interrupt non-terminal integrations (existing recovery behavior).
  deps.managedTaskRepo?.interruptNonterminalIntegrations(
    goalId,
    "Integration attempt interrupted because backend adapter control was lost during restart.",
    runId,
  );

  // 4. Leave the goal in a clean, resumable, non-terminal interrupted state.
  deps.goalRepo.updateStatus(goalId, "interrupted");
  deps.eventRepo.create({
    goalId,
    runId,
    type: "agent.progress",
    message: "Restart-interrupted goal reconciled to a resumable state.",
    data: {
      runtimeEventType: "recovery.reconciled",
      sessionId: session.id,
      deliveriesReset,
      attemptsInterrupted,
      tasksReset,
      recoveryState: "interrupted",
    },
  });
}

interface SupervisorState {
  /** Goals whose supervisor already emitted a completion signal. */
  completedGoals: Set<string>;
  /** Per-goal count of continuations started because a session ended without successfully completing. */
  completionlessContinuations: Map<string, number>;
  /** Per-goal safe reason of the most recent rejected control block. */
  lastRejectionReasons: Map<string, string>;
  /** Goals for which at least one valid completion request was rejected. */
  completionRequestsEvaluated: Set<string>;
  /** Per-goal structured gaps from the most recent rejected completion request. */
  lastCompletionGaps: Map<string, ManagedCompletionGap[]>;
  /** Per-goal frozen acceptance-contract registry. */
  taskRegistries: Map<string, GoalTaskRegistry>;
  /** Per-goal change-plan registry. */
  changeRegistries: Map<string, GoalChangeRegistry>;
  /** Goals whose openspec degraded mode was already reported. */
  openspecDowngradeReported: Set<string>;
  /** Per goal+role resolved child agent (null = use the goal default). */
  roleResolutions: Map<string, ResolvedRoleAgentLike | null>;
  maxSupervisorContinuations: number;
  maxPlanningEpochs: number;
  openSpec: OpenSpecWorkspaceService;
  supervisorCwd: string;
}

function getTaskRegistry(state: SupervisorState, goalId: string): GoalTaskRegistry {
  let registry = state.taskRegistries.get(goalId);
  if (!registry) {
    registry = new GoalTaskRegistry();
    state.taskRegistries.set(goalId, registry);
  }
  return registry;
}

function getChangeRegistry(state: SupervisorState, goalId: string): GoalChangeRegistry {
  let registry = state.changeRegistries.get(goalId);
  if (!registry) {
    registry = new GoalChangeRegistry();
    state.changeRegistries.set(goalId, registry);
  }
  return registry;
}

interface SessionEventContext {
  goalId: string;
  runId: string;
  sessionId: string;
  providerId: string;
  modelLabel: string | null;
  adapter: AgentRuntimeAdapter;
  activeHandles: Map<string, AgentSessionHandle>;
  runtimeCommandIds: Map<string, string>;
  state: SupervisorState;
}

interface PersistRuntimeEventInput extends SessionEventContext {
  event: AgentRuntimeEvent;
}

async function runSessionEvents(
  deps: AgentSessionManagerDeps,
  input: SessionEventContext & { handle: AgentSessionHandle },
): Promise<void> {
  let providerSessionCaptured = false;
  try {
    for await (const event of input.handle.events()) {
      // Capture the provider-native session id the first time it is reported so a
      // later boot can resume this session (Phase 4). Persistence only.
      const providerSessionId = event.metadata?.providerSessionId;
      if (providerSessionId && !providerSessionCaptured) {
        providerSessionCaptured = true;
        deps.agentSessionRepo.updateProviderSessionId(input.sessionId, providerSessionId);
      }
      await persistRuntimeEvent(deps, { ...input, event });
    }
  } catch (error) {
    if (!(error instanceof PostCommitCacheRefreshInterruption)) {
      recordEventPumpFailure(deps, input, error);
    }
  } finally {
    input.activeHandles.delete(input.sessionId);
    clearRuntimeCommandIds(input.runtimeCommandIds, input.sessionId);
  }
}

/**
 * Terminal containment for the session event pump: a control-path fault must
 * surface as a durable error event and a visibly failed run, never as an
 * unhandled rejection (both continuation call sites are fire-and-forget).
 */
function recordEventPumpFailure(
  deps: AgentSessionManagerDeps,
  input: SessionEventContext,
  error: unknown,
): void {
  const finishedAt = new Date().toISOString();
  const safeReason = sanitizeArchiveReason(safeErrorMessage(error), input.state.supervisorCwd);
  try {
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "failed");
    deps.runRepo.updateStatus(input.runId, "failed", { finishedAt, error: safeReason });
    const goal = deps.goalRepo.getById(input.goalId);
    if (goal && !["completed", "failed", "blocked", "cancelled"].includes(goal.status)) {
      deps.goalRepo.updateStatus(input.goalId, "failed", { completedAt: finishedAt });
    }
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "error",
      message: "Runtime event handling failed; run stopped.",
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "runtime.event_pump_failed",
        safeReason,
      },
    });
  } catch {
    // The durable store itself failed; keeping the process alive is the only
    // remaining containment.
  }
}

async function persistRuntimeEvent(deps: AgentSessionManagerDeps, input: PersistRuntimeEventInput): Promise<void> {
  const data = {
    sessionId: input.sessionId,
    provider: input.providerId,
    model: input.modelLabel,
    ...input.event.metadata,
  };

  if (input.event.metadata?.delegationControlEvent !== undefined) {
    await persistDelegationControlEvent(deps, input, data);
    return;
  }

  if (input.event.type === "command.started") {
    const command = deps.agentSessionRepo.recordCommand({
      sessionId: input.sessionId,
      status: "running",
      safeCommand: input.event.message,
      cwd: null,
      startedAt: input.event.occurredAt,
      completedAt: null,
      exitCode: null,
      diagnostics: null,
    });
    if (input.event.metadata?.commandId) {
      input.runtimeCommandIds.set(runtimeCommandKey(input.sessionId, input.event.metadata.commandId), command.id);
    }
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.command.started",
      message: input.event.message,
      data: { ...data, commandId: command.id, runtimeEventType: input.event.type },
    });
    return;
  }

  if (input.event.type === "approval.requested") {
    const durableCommandId = input.event.metadata?.commandId
      ? input.runtimeCommandIds.get(runtimeCommandKey(input.sessionId, input.event.metadata.commandId))
      : undefined;
    const approval = deps.agentSessionRepo.createApprovalRequest({
      sessionId: input.sessionId,
      commandId: durableCommandId ?? null,
      safeSummary: input.event.message,
    });
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "waiting_approval");
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: input.event.message,
      data: {
        ...data,
        commandId: durableCommandId ?? data.commandId,
        approvalRequestId: approval.id,
        runtimeEventType: input.event.type,
      },
    });
    return;
  }

  if (input.event.type === "child_session.requested") {
    const request = deps.agentSessionRepo.recordChildSessionRequest({
      parentSessionId: input.sessionId,
      parentAgentId: input.event.metadata?.parentAgentId ?? null,
      childRole: input.event.metadata?.agentId ?? "child-agent",
      taskId: input.event.metadata?.taskId ?? null,
      promptSummary: input.event.message,
    });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: input.event.message,
      data: { ...data, childSessionRequestId: request.id, runtimeEventType: input.event.type },
    });
    return;
  }

  if (input.event.type === "session.completed") {
    const finishedAt = new Date().toISOString();
    const session = deps.agentSessionRepo.getSession(input.sessionId);
    // Delegation-capable supervisors complete the goal only through an
    // explicit completion control block; a session process exiting is just the
    // end of one turn.
    const supervisorContract = !session?.parent && session?.capabilities.childSessions === true;
    if (supervisorContract && input.state.completedGoals.has(input.goalId)) {
      deps.agentSessionRepo.updateLifecycleState(input.sessionId, "completed");
      return;
    }
    const hasActiveDelegation =
      supervisorContract &&
      deps.agentSessionRepo
        .listDelegationRequests(input.sessionId)
        .some((request) => ["requested", "accepted", "running"].includes(request.status));
    if (!hasActiveDelegation) {
      // A supervisor whose process exits while its child is still running must
      // stay in waiting_child: marking it completed would detach the child
      // result and strand the goal.
      deps.agentSessionRepo.updateLifecycleState(input.sessionId, "completed");
    }
    deps.runRepo.updateStatus(input.runId, "completed", { finishedAt });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "run.completed",
      message: "Managed agent session completed",
      data,
    });

    if (!supervisorContract) {
      deps.goalRepo.updateStatus(input.goalId, "completed", { completedAt: finishedAt });
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "goal.completed",
        message: "Goal completed successfully",
        data: { ...data, goalId: input.goalId },
      });
      return;
    }

    if (hasActiveDelegation) {
      // The child outcome continuation will pick the supervisor back up.
      return;
    }
    await startCompletionlessContinuation(deps, input, data);
    return;
  }

  if (input.event.type === "session.failed") {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "failed");
    deps.runRepo.updateStatus(input.runId, "failed", { finishedAt, error: input.event.message });
    deps.goalRepo.updateStatus(input.goalId, "failed", { completedAt: finishedAt });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "error",
      message: input.event.message,
      data,
    });
    return;
  }

  if (input.event.type === "session.cancelled") {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "cancelled");
    deps.runRepo.updateStatus(input.runId, "failed", { finishedAt, error: input.event.message });
    deps.goalRepo.updateStatus(input.goalId, "failed", { completedAt: finishedAt });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "error",
      message: input.event.message,
      data,
    });
    return;
  }

  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: runtimeEventTypeToEventType(input.event.type),
    message: input.event.message,
    data: { ...data, runtimeEventType: input.event.type },
  });
}

async function persistDelegationControlEvent(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  data: Record<string, unknown>,
): Promise<void> {
  const parentSession = deps.agentSessionRepo.getSession(input.sessionId);
  if (!parentSession) {
    throw new Error(`Agent session not found: ${input.sessionId}`);
  }

  const validation = validateManagedControlEvent({
    controlEvent: input.event.metadata?.delegationControlEvent,
    parentSession,
  });
  if (!validation.ok) {
    recordControlRejection(deps, input, data, validation.safeReason);
    return;
  }

  if (validation.kind === "task_list") {
    const changeRegistry = getChangeRegistry(input.state, input.goalId);
    const changeResolution = changeRegistry.resolveChangeId(validation.changeId);
    if (!changeResolution.ok) {
      recordControlRejection(deps, input, data, changeResolution.safeReason);
      return;
    }
    const registry = getTaskRegistry(input.state, input.goalId);
    let registered: ReturnType<GoalTaskRegistry["registerTaskList"]>;
    if (deps.managedTaskRepo) {
      try {
        deps.managedTaskRepo.registerTasks({
          goalId: input.goalId,
          changeId: changeResolution.changeId,
          runId: input.runId,
          tasks: validation.tasks,
        });
      } catch (error) {
        recordControlRejection(
          deps,
          input,
          data,
          `Task list rejected: ${safeErrorMessage(error)}`.slice(0, 1000),
        );
        return;
      }
      try {
        rehydrateTaskRegistry(registry, deps.managedTaskRepo, input.goalId);
        registered = {
          tasks: validation.tasks.map((task) => registry.getTask(task.id)!).filter(Boolean),
          ignoredMutations: [],
        };
      } catch (error) {
        const safeReason = safeErrorMessage(error).replace(/\s+/g, " ").trim().slice(0, 500);
        const finishedAt = new Date().toISOString();
        deps.agentSessionRepo.updateLifecycleState(input.sessionId, "stalled");
        deps.runRepo.updateStatus(input.runId, "failed", {
          finishedAt,
          error: "Durable task registration committed, but runtime cache refresh failed.",
        });
        deps.goalRepo.updateStatus(input.goalId, "interrupted");
        deps.eventRepo.create({
          goalId: input.goalId,
          runId: input.runId,
          type: "agent.progress",
          message: "Durable task registration committed, but runtime cache refresh failed; restart rehydration is required.",
          data: {
            ...data,
            delegationControlEvent: undefined,
            runtimeEventType: "managed_task.cache_refresh_failed",
            recoveryState: "interrupted",
            safeReason,
          },
        });
        throw new PostCommitCacheRefreshInterruption(safeReason);
      }
    } else {
      try {
        registered = registry.registerTaskList(validation.tasks);
      } catch (error) {
        recordControlRejection(
          deps,
          input,
          data,
          `Task list rejected: ${safeErrorMessage(error)}`.slice(0, 1000),
        );
        return;
      }
    }
    if (changeResolution.changeId) {
      for (const task of validation.tasks) {
        // Tasks already owned by another change (e.g. a later change's spec
        // task in a plan-wide announcement) keep their ownership; inheriting
        // them here would dilute one-active-change sequencing.
        if (!changeRegistry.findChangeByTask(task.id)) {
          changeRegistry.registerTask(changeResolution.changeId, task.id);
        }
      }
    }
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: "Supervisor task list recorded.",
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: "supervisor.task_list",
        taskList: validation.tasks,
        ...(changeResolution.changeId ? { changeId: changeResolution.changeId } : {}),
        ...(registered.ignoredMutations.length > 0
          ? { ignoredCriteriaMutations: registered.ignoredMutations }
          : {}),
      },
    });
    return;
  }

  if (validation.kind === "completion") {
    const completionChangeRegistry = getChangeRegistry(input.state, input.goalId);
    if (completionChangeRegistry.hasPlan()) {
      // A completion claim is the moment to close out an archivable tail
      // change (e.g. one whose only task was its spec) before judging it.
      tryArchiveActiveChange(deps, input);
      // Blocked changes are terminal dead scope (re-planned via reassessment);
      // only open changes hold completion back.
      if (completionChangeRegistry.openChangeIds().length > 0) {
        const completionGaps: ManagedCompletionGap[] = completionChangeRegistry.openChangeIds().map((changeId) => ({
          type: "unarchived_change",
          changeId,
          safeSummary: `Planned change ${changeId} is not archived.`,
        }));
        recordCompletionRejection(
          deps,
          input,
          { ...data, completionGaps },
          `Planned changes remain unarchived: ${completionChangeRegistry.openChangeIds().join(", ")}. ` +
            "Deliver, merge, and archive them before completing the goal.",
          completionGaps,
        );
        return;
      }
      // Completion binds to the latest goal-level reassessment (AC5): the
      // registered work being done is not proof the original goal is met.
      const latestReassessment = completionChangeRegistry.latestReassessment();
      if (!latestReassessment || latestReassessment.epochSequence !== completionChangeRegistry.epochCount()) {
        recordControlRejection(
          deps,
          input,
          data,
          "Completion requires a goal-level reassessment of this epoch first. " +
            "Emit a managed_goal.reassessment control block re-reading the original goal against delivered evidence.",
        );
        return;
      }
      if (!latestReassessment.goalSatisfied) {
        recordControlRejection(
          deps,
          input,
          data,
          "The latest reassessment found remaining gaps; announce the next epoch's change plan instead of completing.",
        );
        return;
      }
    }
    if (deps.database && deps.managedTaskRepo) {
      const evaluated = evaluateManagedCompletion(deps.database, {
        goalId: input.goalId,
        unarchivedChangeIds: completionChangeRegistry.hasPlan() ? completionChangeRegistry.openChangeIds() : [],
        blockedChangeIds: completionChangeRegistry.hasPlan() ? completionChangeRegistry.blockedIds() : [],
      });
      if (!evaluated.ok) {
        recordCompletionRejection(
          deps,
          input,
          { ...data, completionGaps: evaluated.gaps },
          `Completion blocked by durable gaps: ${evaluated.gaps.map((gap) => gap.safeSummary).join(" ")}`.slice(0, 1000),
          evaluated.gaps,
        );
        return;
      }
    }
    const complete = () => {
      const finishedAt = new Date().toISOString();
      deps.agentSessionRepo.updateLifecycleState(input.sessionId, "completed");
      deps.runRepo.updateStatus(input.runId, "completed", { finishedAt });
      deps.goalRepo.updateStatus(input.goalId, "completed", { completedAt: finishedAt });
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "run.completed",
        message: "Supervisor signalled goal completion.",
        data: {
          ...data,
          delegationControlEvent: undefined,
          runtimeEventType: "supervisor.completed",
          safeSummary: validation.summary,
        },
      });
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "goal.completed",
        message: validation.summary,
        data: {
          ...data,
          delegationControlEvent: undefined,
          runtimeEventType: "supervisor.completed",
          goalId: input.goalId,
          safeSummary: validation.summary,
        },
      });
    };
    if (deps.database) deps.database.transaction(complete)();
    else complete();
    input.state.completedGoals.add(input.goalId);
    input.state.completionRequestsEvaluated.delete(input.goalId);
    input.state.lastCompletionGaps.delete(input.goalId);
    return;
  }

  if (validation.kind === "change_plan") {
    const changeRegistry = getChangeRegistry(input.state, input.goalId);
    // A goal with a plan may only open the next epoch; the registry gate
    // requires an unconsumed unsatisfied reassessment (AC3).
    const planGate = changeRegistry.hasPlan()
      ? changeRegistry.registerNextEpoch(validation.plan.changes)
      : changeRegistry.registerPlan(validation.plan.changes);
    if (!planGate.ok) {
      recordControlRejection(deps, input, data, planGate.safeReason);
      return;
    }
    const epoch = changeRegistry.listEpochs().at(-1)!;

    if (input.state.openSpec.mode() === "degraded" && !input.state.openspecDowngradeReported.has(input.goalId)) {
      input.state.openspecDowngradeReported.add(input.goalId);
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "agent.progress",
        message: "OpenSpec CLI unavailable; using internal templates and structural checks.",
        data: {
          ...data,
          delegationControlEvent: undefined,
          runtimeEventType: "runtime.openspec_unavailable",
        },
      });
    }

    const orderedChanges = changeRegistry
      .listChanges()
      .filter((change) => change.epochSequence === epoch.sequence);
    const specTasks = orderedChanges.map((change) => ({
      taskId: specTaskId(change.id),
      changeId: change.id,
      acceptance: specTaskAcceptance(change.id),
    }));
    const taskEntries = specTasks.map((task) => ({
      id: task.taskId,
      title: `Author OpenSpec artifacts for change ${task.changeId}`,
      acceptance: task.acceptance,
      parentTaskId: null,
    }));
    getTaskRegistry(input.state, input.goalId).registerTaskList(
      taskEntries,
    );
    const persistPlanIntent = () => {
      deps.managedTaskRepo?.registerTasks({
        goalId: input.goalId,
        runId: input.runId,
        tasks: taskEntries,
      });
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "agent.progress",
        message: `Supervisor change plan recorded (planning epoch ${epoch.sequence}).`,
        data: {
          ...data,
          delegationControlEvent: undefined,
          runtimeEventType: "supervisor.change_plan",
          changePlan: validation.plan.changes,
          specTasks,
          epochSequence: epoch.sequence,
          ...(epoch.rationale ? { epochRationale: epoch.rationale } : {}),
        },
      });
    };
    if (deps.database) deps.database.transaction(persistPlanIntent)();
    else persistPlanIntent();

    const scaffolds = orderedChanges.map((change) => {
      const scaffold = input.state.openSpec.scaffoldChange({
        cwd: input.state.supervisorCwd,
        change: {
          id: change.id,
          title: change.title,
          rationale: change.rationale,
          dependsOn: change.dependsOn.length > 0 ? change.dependsOn : null,
        },
      });
      return {
        changeId: change.id,
        ok: scaffold.ok,
        committed: scaffold.committed,
        ...(scaffold.safeReason ? { safeReason: scaffold.safeReason } : {}),
      };
    });
    const materializationFailures = scaffolds.filter((scaffold) => !scaffold.ok || !scaffold.committed);
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: materializationFailures.length > 0 ? "error" : "agent.progress",
      message: materializationFailures.length > 0
        ? "OpenSpec change scaffolding completed with failures."
        : "OpenSpec change scaffolding materialized.",
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: materializationFailures.length > 0
          ? "runtime.openspec_materialization_failed"
          : "runtime.openspec_materialized",
        openspecScaffolds: scaffolds,
      },
    });

    const active = changeRegistry.activeChange();
    if (active) {
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "agent.progress",
        message: `Change ${active.id} activated.`,
        data: {
          ...data,
          delegationControlEvent: undefined,
          runtimeEventType: "change.activated",
          changeId: active.id,
        },
      });
    }
    return;
  }

  if (validation.kind === "reassessment") {
    const changeRegistry = getChangeRegistry(input.state, input.goalId);
    if (!changeRegistry.hasPlan()) {
      recordControlRejection(
        deps, input, data,
        "Goal has no change plan; reassessment applies to planned goals only.",
      );
      return;
    }
    // Close out an archivable tail change before judging the batch (same
    // courtesy as the completion path).
    tryArchiveActiveChange(deps, input);
    const openChanges = changeRegistry.openChangeIds();
    if (openChanges.length > 0) {
      recordControlRejection(
        deps, input, data,
        `Reassessment requires every change archived or blocked first; open: ${openChanges.join(", ")}.`,
      );
      return;
    }
    if (validation.reassessment.goalSatisfied && deps.database && deps.managedTaskRepo) {
      // The durable ledger outranks the supervisor's prose: a satisfied claim
      // must survive the same evidence check completion uses.
      const evaluated = evaluateManagedCompletion(deps.database, {
        goalId: input.goalId,
        unarchivedChangeIds: [],
        blockedChangeIds: changeRegistry.blockedIds(),
      });
      if (!evaluated.ok) {
        recordControlRejection(
          deps,
          input,
          { ...data, completionGaps: evaluated.gaps },
          `Satisfied reassessment contradicts durable gaps: ${evaluated.gaps.map((gap) => gap.safeSummary).join(" ")}`
            .slice(0, 1000),
        );
        return;
      }
    }
    if (!validation.reassessment.goalSatisfied) {
      const refRejection = resolveReassessmentGapRefs(input, validation.reassessment, changeRegistry);
      if (refRejection) {
        recordControlRejection(deps, input, data, refRejection);
        return;
      }
      const previous = changeRegistry.latestReassessment();
      const signature = reassessmentGapSignature(validation.reassessment.remainingGaps);
      if (previous && !previous.goalSatisfied && signature.length > 0 &&
          reassessmentGapSignature(previous.remainingGaps) === signature) {
        blockGoalForMacroLoop(
          deps, input,
          "supervisor.reassessment_circuit_breaker",
          "Consecutive reassessments reported the same remaining gaps; the macro loop is not converging.",
          validation.reassessment,
        );
        return;
      }
      const epochBudget = effectiveBudget(deps, input.state, input.goalId, "planning_epochs");
      if (changeRegistry.epochCount() >= epochBudget) {
        blockGoalForMacroLoop(
          deps, input,
          "supervisor.epoch_budget_exhausted",
          `Goal reached its planning-epoch budget (${epochBudget}) with gaps remaining.`,
          validation.reassessment,
        );
        return;
      }
    }
    const recorded = changeRegistry.recordReassessment(validation.reassessment);
    if (!recorded.ok) {
      recordControlRejection(deps, input, data, recorded.safeReason);
      return;
    }
    const epochSequence = changeRegistry.latestReassessment()!.epochSequence;
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: validation.reassessment.goalSatisfied
        ? `Goal reassessment recorded: satisfied (epoch ${epochSequence}).`
        : `Goal reassessment recorded: gaps remain (epoch ${epochSequence}); next epoch admitted.`,
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: "supervisor.reassessment",
        epochSequence,
        goalSatisfied: validation.reassessment.goalSatisfied,
        evidence: validation.reassessment.evidence,
        remainingGaps: validation.reassessment.remainingGaps,
        ...(validation.reassessment.nextEpochRationale
          ? { nextEpochRationale: validation.reassessment.nextEpochRationale }
          : {}),
      },
    });
    return;
  }

  if (validation.kind === "task_result") {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: "Task result recorded.",
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: "task.result",
        taskResult: validation.result,
      },
    });
    return;
  }

  if (validation.kind === "spec_review") {
    const review = validation.review;
    const changeRegistry = getChangeRegistry(input.state, input.goalId);
    const taskId = specTaskId(review.changeId);
    if (review.decision === "reject" && deps.managedTaskRepo) {
      // Guard before recording anything: the durable ledger may have moved
      // (recovery, delivery rejection); an illegal transition must surface as
      // a rejected control block, never as a thrown error.
      const durableTask = deps.managedTaskRepo.getTask(input.goalId, taskId);
      if (durableTask && !["awaiting_review", "awaiting_delivery"].includes(durableTask.status)) {
        recordControlRejection(
          deps, input, data,
          `Spec task ${taskId} cannot record a Supervisor rejection from durable status ${durableTask.status}.`,
        );
        return;
      }
    }
    const recorded = changeRegistry.recordSpecReview(review);
    if (!recorded.ok) {
      recordControlRejection(deps, input, data, recorded.safeReason);
      return;
    }
    if (recorded.duplicate) return;

    if (review.decision === "reject") {
      if (deps.managedTaskRepo?.getTask(input.goalId, taskId)) {
        deps.managedTaskRepo.transition(taskId, "rejected", {
          goalId: input.goalId,
          runId: input.runId,
          safeSummary: review.summary,
        });
      }
      getTaskRegistry(input.state, input.goalId).markFailed(taskId);
    }
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: review.decision === "approve"
        ? "Supervisor approved the validated spec attempt."
        : "Supervisor rejected the validated spec attempt.",
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: review.decision === "approve"
          ? "change.spec_supervisor_approved"
          : "change.spec_supervisor_rejected",
        changeId: review.changeId,
        taskId,
        workerDelegationRequestId: review.workerDelegationRequestId,
        summary: review.summary,
        safeSummary: review.summary,
      },
    });
    return;
  }

  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  const changeResolution = changeRegistry.resolveChangeId(validation.request.changeId ?? null);
  if (!changeResolution.ok) {
    recordControlRejection(deps, input, data, changeResolution.safeReason);
    return;
  }
  const owningChange = validation.request.taskId
    ? changeRegistry.findChangeByTask(validation.request.taskId)
    : undefined;
  if (owningChange && owningChange.id !== changeResolution.changeId) {
    recordControlRejection(
      deps,
      input,
      data,
      `Change ${owningChange.id} is not active. Work on the active change ${changeResolution.changeId} first.`,
    );
    return;
  }
  if (changeResolution.changeId && validation.request.taskId) {
    changeRegistry.registerTask(changeResolution.changeId, validation.request.taskId);
  }
  const specChange =
    validation.request.taskId && validation.request.taskId.startsWith("spec:")
      ? changeRegistry.getChange(validation.request.taskId.slice("spec:".length))
      : undefined;
  if (validation.request.role === "worker" && !specChange && changeResolution.changeId) {
    const activeChange = changeRegistry.getChange(changeResolution.changeId);
    if (activeChange && activeChange.status === "specifying") {
      // Prompt text tells the supervisor to wait for merged specs; this is
      // the deterministic version of that rule.
      recordControlRejection(
        deps,
        input,
        data,
        `Change ${activeChange.id} is still specifying. Deliver and review-merge ` +
          `${specTaskId(activeChange.id)} before delegating implementation tasks.`,
      );
      return;
    }
  }

  const registry = getTaskRegistry(input.state, input.goalId);
  let dispatchAcceptance = validation.request.acceptance ?? null;
  let uncontracted = false;
  if (validation.request.role === "worker") {
    if (deps.managedTaskRepo) {
      const durableTask = validation.request.taskId
        ? deps.managedTaskRepo.getTask(input.goalId, validation.request.taskId)
        : null;
      if (!durableTask) {
        uncontracted = true;
      } else {
        const criteria = deps.managedTaskRepo.listCriteria(input.goalId, durableTask.id);
        if (criteria.length === 0) {
          recordControlRejection(
            deps, input, data,
            `Task ${durableTask.id} has no frozen acceptance criteria. Register a testable contract before delegating.`,
          );
          return;
        }
        if (durableTask.status === "split") {
          recordControlRejection(deps, input, data, `Task ${durableTask.id} was split; delegate its leaf descendants.`);
          return;
        }
        if (durableTask.substantiveRejectionCount >= 2 || durableTask.attemptCount >= 3) {
          if (specChange) {
            // Spec tasks cannot narrow (frozen S1-S3, change keys on this id):
            // exhausting the budget blocks the change, never the goal.
            if (!["accepted", "blocked", "split"].includes(durableTask.status)) {
              deps.managedTaskRepo.transition(durableTask.id, "blocked", {
                safeSummary: `Spec authoring for change ${specChange.id} exhausted its retry budget.`,
                runId: input.runId,
                citedCriteria: durableTask.lastCitedCriteria,
                goalId: input.goalId,
              });
            }
            blockChangeForSpecBudget(deps, input, data, specChange.id);
            return;
          }
          if (durableTask.status !== "accepted") {
            deps.managedTaskRepo.transition(durableTask.id, "split", {
              safeSummary: `Task ${durableTask.id} exhausted its retry budget and must be narrowed.`,
              runId: input.runId,
              citedCriteria: durableTask.lastCitedCriteria,
              goalId: input.goalId,
            });
          }
          recordControlRejection(
            deps, input, data,
            `Task ${durableTask.id} reached its durable retry budget. Split the cited criteria into narrower child tasks.`,
          );
          return;
        }
        dispatchAcceptance = criteria.map((criterion) => ({ id: criterion.criterionId, text: criterion.text }));
      }
    } else {
    const task = validation.request.taskId ? registry.getTask(validation.request.taskId) : undefined;
    if (task && task.attemptCount > 0 && !specChange) {
      // Re-delegating a task implies its previous attempt was rejected. The
      // rejection is substantive only when the supervisor cites frozen
      // criterion ids; otherwise it is just the next attempt. Spec tasks are
      // exempt: the backend already records their validation rejections
      // deterministically, and the corrective re-delegation is expected to
      // cite the failing criteria — counting it again would double-charge
      // one failure against the retry budget.
      const verdict = registry.classifyVerdict(
        task.id,
        `${validation.request.prompt} ${validation.request.promptSummary}`,
      );
      if (verdict.substantive) {
        deps.eventRepo.create({
          goalId: input.goalId,
          runId: input.runId,
          type: "agent.progress",
          message: "Substantive task rejection recorded.",
          data: {
            ...data,
            delegationControlEvent: undefined,
            runtimeEventType: "task.rejection_recorded",
            taskId: task.id,
            citedCriteria: verdict.citedCriteria,
            rejectionCount: task.substantiveRejections,
          },
        });
      }
    }
    const gate = registry.gateWorkerDelegation(validation.request.taskId ?? null, dispatchAcceptance);
    if (!gate.ok) {
      if (specChange && registry.getTask(specTaskId(specChange.id))?.status === "split") {
        // Narrowing cannot apply to a backend-registered spec task: its S1-S3
        // contract is frozen and change approval keys on this exact task id.
        // Exhausting the spec budget blocks the change — the goal survives to
        // re-plan the blocked scope through the reassessment loop.
        blockChangeForSpecBudget(deps, input, data, specChange.id);
        return;
      }
      recordControlRejection(deps, input, data, gate.safeReason);
      return;
    }
    dispatchAcceptance = gate.acceptance;
    uncontracted = gate.uncontracted;
    }
  }

  let checkAppendix: string | null = null;
  if (validation.request.role === "review_merge" && validation.request.workerDelegationRequestId) {
    const worker = findDelegationForGoal(deps, input.goalId, validation.request.workerDelegationRequestId);
    const workerTaskId = worker?.taskId;
    const workerChange = workerTaskId ? changeRegistry.findChangeByTask(workerTaskId) : undefined;
    if (workerChange && workerTaskId === specTaskId(workerChange.id)) {
      const gate = changeRegistry.gateSpecReviewMerge(
        workerChange.id,
        validation.request.workerDelegationRequestId,
      );
      if (!gate.ok) {
        recordControlRejection(deps, input, data, gate.safeReason);
        return;
      }
    }
    if (worker) {
      const checks = await executeAcceptanceChecks(deps, input, worker);
      if (checks.rejectReason) {
        recordControlRejection(deps, input, data, checks.rejectReason);
        return;
      }
      checkAppendix = checks.appendix;
    }
  }

  const childAgent = await resolveChildAgent(deps, input, validation.request.role);

  try {
    await createDelegationCoordinator({ ...deps, activeHandles: input.activeHandles }).acceptAndStartWorker({
      parentSessionId: input.sessionId,
      providerId: childAgent.providerId,
      modelLabel: childAgent.modelLabel,
      role: validation.request.role,
      prompt: validation.request.prompt,
      promptSummary: validation.request.promptSummary,
      taskId: validation.request.taskId,
      changeId: changeResolution.changeId,
      acceptance: dispatchAcceptance,
      promptAppendix: specChange
        ? buildSpecWriterAppendix({
            id: specChange.id,
            title: specChange.title,
            rationale: specChange.rationale,
            dependsOn: specChange.dependsOn,
            supervisorFeedback: specChange.specReview.decision === "reject"
              ? specChange.specReview.summary
              : null,
          })
        : checkAppendix,
      workerDelegationRequestId: validation.request.workerDelegationRequestId,
      adapter: childAgent.adapter,
      eventData: { ...data, ...(uncontracted ? { uncontracted: true } : {}) },
      onAccepted: specChange
        ? (delegationRequestId) => changeRegistry.markSpecAttemptStarted(specChange.id, delegationRequestId)
        : undefined,
      onChildOutcome: async (outcome) => {
        const backendRejection = await recordChildOutcomeInRegistry(deps, input, outcome);
        if (backendRejection === CONDITIONAL_RECOVERY_DEFERRED) return;
        const specReviewAppendix = backendRejection
          ? null
          : recordSpecReviewRequested(deps, input, outcome);
        // Fresh continuations are new sessions with no memory of delegation
        // ids; the observation must carry the id a later review-merge request
        // will reference.
        const taggedObservation =
          outcome.role === "worker"
            ? `${outcome.observation} [workerDelegationRequestId: ${outcome.delegationRequestId}]`
            : outcome.observation;
        const observation = backendRejection
          ? `${taggedObservation}\n\nBackend validation rejected this result. Failing checks: ${backendRejection}`
          : specReviewAppendix
            ? `${taggedObservation}\n\n${specReviewAppendix}`
            : taggedObservation;
        await continueSupervisorAfterChild(deps, input, observation, {
          delegationRequestId: outcome.delegationRequestId,
          childSessionId: outcome.childSessionId,
        });
      },
    });
  } catch (err) {
    const safeReason = err instanceof Error ? err.message : "Delegation request rejected.";
    recordControlRejection(deps, input, data, safeReason);
  }
}

/**
 * Resolve the agent a child role runs on: the user's role assignment when
 * configured and capable, otherwise the goal's default adapter. Cached per
 * goal+role; downgrades are durable.
 */
async function resolveChildAgent(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  role: "worker" | "review_merge" | "integrator",
): Promise<ResolvedRoleAgentLike> {
  const fallback: ResolvedRoleAgentLike = {
    adapter: input.adapter,
    providerId: input.providerId,
    modelLabel: input.modelLabel,
  };
  if (!deps.roleAdapterResolver) {
    return fallback;
  }
  const cacheKey = `${input.goalId}:${role}`;
  const cached = input.state.roleResolutions.get(cacheKey);
  if (cached !== undefined) {
    return cached ?? fallback;
  }

  let resolved: ResolvedRoleAgentLike | null = null;
  let downgradeReason: string | null = null;
  try {
    resolved = deps.roleAdapterResolver(role as AgentAssignableRole);
    if (resolved) {
      const capabilities = await resolved.adapter.detectCapabilities();
      if (!capabilities.eventStreaming) {
        downgradeReason =
          capabilities.unsupportedReasons?.approval ??
          "Assigned provider does not support managed execution.";
        resolved = null;
      }
    }
  } catch (err) {
    downgradeReason = err instanceof Error ? err.message : "Role assignment resolution failed.";
    resolved = null;
  }

  if (downgradeReason) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Role assignment for ${role} downgraded to the goal provider.`,
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "role_assignment.downgraded",
        role,
        reason: downgradeReason,
      },
    });
  }

  input.state.roleResolutions.set(cacheKey, resolved);
  return resolved ?? fallback;
}

const REVIEW_REJECTION_OUTCOMES = new Set(["rejected", "test_failed_reverted", "verification_failed"]);
const CONDITIONAL_RECOVERY_DEFERRED = Symbol("conditional-recovery-deferred");

/**
 * Returns the backend rejection summary when the child result was rejected by
 * a deterministic gate (so the supervisor's continuation can carry it), or
 * null when the outcome was recorded as-is.
 */
async function recordChildOutcomeInRegistry(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
): Promise<string | null | typeof CONDITIONAL_RECOVERY_DEFERRED> {
  if (deps.managedTaskRepo) {
    return recordDurableChildOutcome({ ...deps, managedTaskRepo: deps.managedTaskRepo }, input, outcome);
  }
  const registry = getTaskRegistry(input.state, input.goalId);
  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  if (outcome.role === "worker" && outcome.taskId) {
    if (outcome.resultSummary.kind === "success") {
      const specRejection = rejectInvalidSpecResult(deps, input, outcome, registry);
      if (specRejection) {
        return specRejection;
      }
    }
    if (outcome.resultSummary.kind === "success" && (outcome.resultSummary.attestedFiles?.length ?? 0) > 0) {
      const change = changeRegistry.findChangeByTask(outcome.taskId);
      if (change) changeRegistry.recordAttestedWorkerChanges(change.id);
    }
    registry.recordOutcome(outcome.taskId, outcome.resultSummary);
    tryArchiveActiveChange(deps, input);
    return null;
  }
  if (outcome.role !== "review_merge" || !outcome.workerTaskId) {
    return null;
  }
  const rejecting =
    (outcome.reviewMergeOutcome !== null && REVIEW_REJECTION_OUTCOMES.has(outcome.reviewMergeOutcome)) ||
    outcome.resultSummary.kind === "failure";
  if (!rejecting) {
    if (outcome.reviewMergeOutcome === "merged") {
      const change = changeRegistry.findChangeByTask(outcome.workerTaskId);
      if (change) changeRegistry.recordMerged(change.id);
      const specMerge = completeSpecMergeAfterValidation(
        deps, input, outcome.workerTaskId, outcome.workerDelegationRequestId ?? null, changeRegistry,
      );
      if (!specMerge) {
        // A spec merge only just unlocked the change for implementation
        // tasks; archiving there would close it before any were announced.
        tryArchiveActiveChange(deps, input);
      }
    }
    return null;
  }
  const verdict = registry.classifyVerdict(outcome.workerTaskId, outcome.observation);
  if (verdict.substantive) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: "Substantive task rejection recorded from review.",
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "task.rejection_recorded",
        taskId: outcome.workerTaskId,
        citedCriteria: verdict.citedCriteria,
        rejectionCount: registry.getTask(outcome.workerTaskId)?.substantiveRejections,
      },
    });
    return null;
  }
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: "Review objection recorded as a deferred finding.",
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "task.deferred_finding",
      taskId: outcome.workerTaskId,
      finding: verdict.deferredFinding,
    },
  });
  return null;
}

async function recordDurableChildOutcome(
  deps: AgentSessionManagerDeps & { managedTaskRepo: ManagedTaskRepository },
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
): Promise<string | null | typeof CONDITIONAL_RECOVERY_DEFERRED> {
  const tasks = deps.managedTaskRepo;
  if (outcome.role === "worker" && outcome.taskId && tasks.getTask(input.goalId, outcome.taskId)) {
    if (outcome.resultSummary.kind === "success") {
      tasks.recordExecutorEvidence({
        goalId: input.goalId,
        taskId: outcome.taskId,
        workerDelegationRequestId: outcome.delegationRequestId,
        safeSummary: outcome.resultSummary.safeSummary,
        criterionEvidence: outcome.resultSummary.criterionEvidence ?? [],
        runId: input.runId,
      });
      const change = getChangeRegistry(input.state, input.goalId).findChangeByTask(outcome.taskId);
      if (change && (outcome.resultSummary.attestedFiles?.length ?? 0) > 0) {
        getChangeRegistry(input.state, input.goalId).recordAttestedWorkerChanges(change.id);
      }
    } else {
      tasks.transition(outcome.taskId, "failed", {
        goalId: input.goalId,
        safeSummary: outcome.resultSummary.safeSummary,
        runId: input.runId,
      });
      getTaskRegistry(input.state, input.goalId).markFailed(outcome.taskId);
    }
    return null;
  }
  if (outcome.role !== "review_merge" || !outcome.workerTaskId || !outcome.workerDelegationRequestId) {
    return null;
  }
  if (outcome.reviewDecisionError || !outcome.reviewDecision) {
    const safeReason = outcome.reviewDecisionError ?? "Judge completed without a managed_review.decision block.";
    tasks.recordInvalidReview({
      goalId: input.goalId,
      taskId: outcome.workerTaskId,
      workerDelegationRequestId: outcome.workerDelegationRequestId,
      judgeDelegationRequestId: outcome.delegationRequestId,
      safeSummary: safeReason,
      deferredFindings: outcome.observation ? [outcome.observation.slice(0, 500)] : [],
      runId: input.runId,
    });
    return safeReason;
  }

  const worker = findDelegationForGoal(deps, input.goalId, outcome.workerDelegationRequestId);
  if (!worker?.resultSummary) {
    return "Reviewed worker attempt could not be reloaded from durable delegation state.";
  }
  const attestedFiles = worker.resultSummary.attestedFiles ?? [];
  const review = tasks.recordReview({
    goalId: input.goalId,
    taskId: outcome.workerTaskId,
    workerDelegationRequestId: outcome.workerDelegationRequestId,
    judgeDelegationRequestId: outcome.delegationRequestId,
    verdict: outcome.reviewDecision.verdict,
    decisions: outcome.reviewDecision.decisions,
    safeSummary: outcome.reviewDecision.safeSummary,
    deferredFindings: outcome.reviewDecision.deferredFindings ?? [],
    hasAttestedChanges: attestedFiles.length > 0,
    runId: input.runId,
  });
  if (review.verdict !== "accepted") {
    return null;
  }

  {
    // Executed check outcomes outrank judge prose: a judge PASS over an
    // executed FAIL is overridden durably and the attempt rejected.
    const overrideRejection = enforceExecutedCheckOutcomes(deps, input, outcome, review.verdict);
    if (overrideRejection) return overrideRejection;
  }

  {
    // A spec attempt that changed nothing has nothing to merge: the scaffold
    // alone must never advance the change (zero-attestation gate).
    const changeRegistry = getChangeRegistry(input.state, input.goalId);
    const change = changeRegistry.findChangeByTask(outcome.workerTaskId);
    if (change && specTaskId(change.id) === outcome.workerTaskId && attestedFiles.length === 0) {
      const safeReason =
        `Spec worker attempt ${outcome.workerDelegationRequestId} has no attested changes to deliver. ` +
        `Create a corrective ${outcome.workerTaskId} attempt that writes the approved artifacts.`;
      tasks.recordDelivery({
        goalId: input.goalId,
        taskId: outcome.workerTaskId,
        workerDelegationRequestId: outcome.workerDelegationRequestId,
        status: "rejected",
        safeSummary: safeReason,
        runId: input.runId,
      });
      getTaskRegistry(input.state, input.goalId).markFailed(outcome.workerTaskId);
      return safeReason;
    }
  }

  if (attestedFiles.length > 0) {
    if (!outcome.worktreePath) {
      tasks.recordDelivery({
        goalId: input.goalId,
        taskId: outcome.workerTaskId,
        workerDelegationRequestId: outcome.workerDelegationRequestId,
        status: "verification_failed",
        safeSummary: "Reviewed worker worktree path is unavailable for backend delivery.",
        runId: input.runId,
      });
      return "Reviewed worker worktree path is unavailable for backend delivery.";
    }
    const deliveryService = deps.managedDeliveryService ?? createManagedDeliveryService();
    const prepared = deliveryService.prepareCandidate({
      workerCwd: outcome.worktreePath,
      supervisorCwd: input.state.supervisorCwd,
      attestedFiles,
      safeSummary: review.safeSummary,
      activeChangeId: getChangeRegistry(input.state, input.goalId).findChangeByTask(outcome.workerTaskId)?.id ?? null,
    });
    if (!prepared.ok) {
      tasks.recordDelivery({
        goalId: input.goalId,
        taskId: outcome.workerTaskId,
        workerDelegationRequestId: outcome.workerDelegationRequestId,
        ...prepared.result,
        runId: input.runId,
      });
      return prepared.result.safeSummary;
    }
    // Write-ahead delivery intent (candidate + checkpoint) before the supervisor mutation.
    tasks.recordDelivery({
      goalId: input.goalId,
      taskId: outcome.workerTaskId,
      workerDelegationRequestId: outcome.workerDelegationRequestId,
      status: "pending",
      checkpointHead: prepared.checkpointHead,
      checkpointStatus: "clean",
      candidateCommitSha: prepared.candidateCommitSha,
      safeSummary: "Delivery candidate prepared; applying under backend authority.",
      runId: input.runId,
    });
    const delivered = deliveryService.deliverCandidate({
      supervisorCwd: input.state.supervisorCwd,
      checkpointHead: prepared.checkpointHead,
      candidateCommitSha: prepared.candidateCommitSha,
      safeSummary: review.safeSummary,
    });
    tasks.recordDelivery({
      goalId: input.goalId,
      taskId: outcome.workerTaskId,
      workerDelegationRequestId: outcome.workerDelegationRequestId,
      ...delivered,
      runId: input.runId,
    });
    if (delivered.status === "conflict") {
      const started = await startConditionalIntegrationRecovery(deps, input, outcome, delivered);
      if (started) return CONDITIONAL_RECOVERY_DEFERRED;
    }
    if (delivered.status !== "committed") {
      return delivered.safeSummary;
    }
  }

  getTaskRegistry(input.state, input.goalId).recordOutcome(outcome.workerTaskId, worker.resultSummary);
  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  const change = changeRegistry.findChangeByTask(outcome.workerTaskId);
  if (change) changeRegistry.recordMerged(change.id);
  const specMerge = completeSpecMergeAfterValidation(
    deps, input, outcome.workerTaskId, outcome.workerDelegationRequestId, changeRegistry,
  );
  if (!specMerge) tryArchiveActiveChange(deps, input);
  return null;
}

async function startConditionalIntegrationRecovery(
  deps: AgentSessionManagerDeps & { managedTaskRepo: ManagedTaskRepository },
  input: PersistRuntimeEventInput,
  judgeOutcome: SupervisorContinuationInput,
  conflict: ManagedDeliveryResult,
): Promise<boolean> {
  const taskId = judgeOutcome.workerTaskId!;
  const workerDelegationRequestId = judgeOutcome.workerDelegationRequestId!;
  if (!conflict.checkpointHead || !conflict.candidateCommitSha || !conflict.candidateFiles?.length) return false;

  const tasks = deps.managedTaskRepo;
  const acceptance = tasks.listCriteria(input.goalId, taskId).map((criterion) => ({
    id: criterion.criterionId,
    text: criterion.text,
  }));
  const integration = tasks.beginIntegration({
    goalId: input.goalId,
    taskId,
    workerDelegationRequestId,
    checkpointHead: conflict.checkpointHead,
    originalCandidateCommitSha: conflict.candidateCommitSha,
    conflictFiles: conflict.conflictFiles ?? [],
    allowedFiles: conflict.candidateFiles,
    safeSummary: conflict.safeSummary,
    runId: input.runId,
  });
  const integrationService = deps.managedIntegrationService ?? createManagedIntegrationService({
    worktreeService: deps.worktreeService ?? createGitWorktreeService(),
  });
  const prepared = await integrationService.prepare({
    supervisorCwd: input.state.supervisorCwd,
    integrationAttemptId: integration.id,
    checkpointHead: integration.checkpointHead,
    originalCandidateCommitSha: integration.originalCandidateCommitSha,
    candidateFiles: integration.allowedFiles,
  });
  if (!prepared.ok) {
    tasks.transitionIntegration(integration.id, "resolution_failed", {
      safeSummary: prepared.safeSummary,
      runId: input.runId,
    });
    return false;
  }

  const cleanup = async () => {
    try {
      await integrationService.cleanup({
        supervisorCwd: input.state.supervisorCwd,
        integrationCwd: prepared.worktree.path,
      });
    } catch (error) {
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "agent.progress",
        message: "Integration worktree cleanup requires later retry.",
        data: {
          runtimeEventType: "managed_task.integration_cleanup_failed",
          integrationAttemptId: integration.id,
          safeReason: error instanceof Error ? error.message.slice(0, 500) : "Integration cleanup failed.",
        },
      });
    }
  };
  const continueAfterRecovery = async (outcome: SupervisorContinuationInput, safeSummary: string) => {
    await cleanup();
    await continueSupervisorAfterChild(deps, input, safeSummary, {
      delegationRequestId: outcome.delegationRequestId,
      childSessionId: outcome.childSessionId,
    });
  };
  const failRecovery = async (outcome: SupervisorContinuationInput, safeSummary: string) => {
    const current = tasks.getIntegration(integration.id);
    if (current && ["pending", "resolving", "awaiting_review", "accepted"].includes(current.status)) {
      tasks.transitionIntegration(integration.id, "resolution_failed", { safeSummary, runId: input.runId });
    }
    await continueAfterRecovery(outcome, `Integration recovery failed: ${safeSummary}`);
  };
  const guardRecovery = async (outcome: SupervisorContinuationInput, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      await failRecovery(outcome, error instanceof Error ? error.message.slice(0, 500) : "Recovery orchestration failed.");
    }
  };

  const integratorAgent = await resolveChildAgent(deps, input, "integrator");
  try {
    await createDelegationCoordinator({ ...deps, activeHandles: input.activeHandles }).acceptAndStartWorker({
      parentSessionId: judgeOutcome.parentSessionId,
      providerId: integratorAgent.providerId,
      modelLabel: integratorAgent.modelLabel,
      role: "integrator",
      prompt: buildIntegratorContractAppendix({
        integrationAttemptId: integration.id,
        workerDelegationRequestId,
        checkpointHead: integration.checkpointHead,
        originalCandidateCommitSha: integration.originalCandidateCommitSha,
        acceptance,
        conflictFiles: prepared.conflictFiles,
        allowedFiles: prepared.allowedFiles,
      }),
      promptSummary: "Resolve the recorded delivery conflict in an isolated integration worktree.",
      taskId,
      acceptance,
      workerDelegationRequestId,
      integrationContext: {
        integrationAttemptId: integration.id,
        workerDelegationRequestId,
        checkpointHead: integration.checkpointHead,
        originalCandidateCommitSha: integration.originalCandidateCommitSha,
        worktreePath: prepared.worktree.path,
      },
      adapter: integratorAgent.adapter,
      eventData: { integrationAttemptId: integration.id, trigger: "delivery_conflict" },
      onChildOutcome: async (integratorOutcome) => guardRecovery(integratorOutcome, async () => {
        if (integratorOutcome.integrationResultError || !integratorOutcome.integrationResult ||
            integratorOutcome.resultSummary.kind === "failure") {
          await failRecovery(integratorOutcome,
            integratorOutcome.integrationResultError ?? integratorOutcome.resultSummary.safeSummary);
          return;
        }
        const candidate = integrationService.verifyAndCreateCandidate({
          integrationCwd: prepared.worktree.path,
          checkpointHead: integration.checkpointHead,
          allowedFiles: prepared.allowedFiles,
          safeSummary: integratorOutcome.integrationResult.safeSummary,
        });
        if (!candidate.ok) {
          await failRecovery(integratorOutcome, candidate.safeSummary);
          return;
        }
        tasks.transitionIntegration(integration.id, "awaiting_review", {
          resolvedCandidateCommitSha: candidate.resolvedCandidateCommitSha,
          safeSummary: candidate.safeSummary,
          runId: input.runId,
        });

        const judgeAgent = await resolveChildAgent(deps, input, "review_merge");
        await createDelegationCoordinator({ ...deps, activeHandles: input.activeHandles }).acceptAndStartWorker({
          parentSessionId: judgeOutcome.parentSessionId,
          providerId: judgeAgent.providerId,
          modelLabel: judgeAgent.modelLabel,
          role: "review_merge",
          prompt: "Independently judge the backend-created resolved candidate against the frozen acceptance contract.",
          promptSummary: "Re-Judge the exact resolved integration candidate.",
          taskId,
          acceptance,
          workerDelegationRequestId,
          reviewCandidateContext: {
            integrationAttemptId: integration.id,
            resolvedCandidateCommitSha: candidate.resolvedCandidateCommitSha,
            worktreePath: prepared.worktree.path,
          },
          adapter: judgeAgent.adapter,
          eventData: { integrationAttemptId: integration.id, resolvedCandidateCommitSha: candidate.resolvedCandidateCommitSha },
          onChildOutcome: async (rejudgeOutcome) => guardRecovery(rejudgeOutcome, async () => {
            if (rejudgeOutcome.reviewDecisionError || !rejudgeOutcome.reviewDecision) {
              const safeSummary = rejudgeOutcome.reviewDecisionError ??
                "Judge completed without a candidate-bound managed_review.decision block.";
              tasks.recordInvalidReview({
                goalId: input.goalId,
                taskId,
                workerDelegationRequestId,
                judgeDelegationRequestId: rejudgeOutcome.delegationRequestId,
                safeSummary,
                deferredFindings: rejudgeOutcome.observation ? [rejudgeOutcome.observation.slice(0, 500)] : [],
                runId: input.runId,
              });
              await failRecovery(rejudgeOutcome, safeSummary);
              return;
            }
            const reviewed = tasks.recordReview({
              goalId: input.goalId,
              taskId,
              workerDelegationRequestId,
              judgeDelegationRequestId: rejudgeOutcome.delegationRequestId,
              integrationAttemptId: integration.id,
              reviewedCandidateCommitSha: candidate.resolvedCandidateCommitSha,
              verdict: rejudgeOutcome.reviewDecision.verdict,
              decisions: rejudgeOutcome.reviewDecision.decisions,
              safeSummary: rejudgeOutcome.reviewDecision.safeSummary,
              deferredFindings: rejudgeOutcome.reviewDecision.deferredFindings ?? [],
              hasAttestedChanges: true,
              runId: input.runId,
            });
            if (reviewed.verdict !== "accepted") {
              await continueAfterRecovery(rejudgeOutcome, reviewed.safeSummary);
              return;
            }
            const deliveryService = deps.managedDeliveryService ?? createManagedDeliveryService();
            // Write-ahead delivery intent before the supervisor-mutating apply.
            tasks.recordDelivery({
              goalId: input.goalId,
              taskId,
              workerDelegationRequestId,
              integrationAttemptId: integration.id,
              status: "pending",
              checkpointHead: integration.checkpointHead,
              checkpointStatus: "clean",
              candidateCommitSha: candidate.resolvedCandidateCommitSha,
              safeSummary: "Resolved candidate prepared; applying under backend authority.",
              runId: input.runId,
            });
            const delivered = deliveryService.deliverCandidate?.({
              supervisorCwd: input.state.supervisorCwd,
              checkpointHead: integration.checkpointHead,
              candidateCommitSha: candidate.resolvedCandidateCommitSha,
              safeSummary: reviewed.safeSummary,
            });
            if (!delivered || delivered.status !== "committed") {
              const safeSummary = delivered?.safeSummary ?? "Resolved candidate delivery is unavailable.";
              tasks.transitionIntegration(integration.id, "resolution_failed", { safeSummary, runId: input.runId });
              tasks.recordDelivery({
                goalId: input.goalId,
                taskId,
                workerDelegationRequestId,
                integrationAttemptId: integration.id,
                ...(delivered ?? {}),
                status: "integration_failed",
                safeSummary,
                runId: input.runId,
              });
              await continueAfterRecovery(rejudgeOutcome, `Integration delivery failed: ${safeSummary}`);
              return;
            }
            tasks.recordDelivery({
              goalId: input.goalId,
              taskId,
              workerDelegationRequestId,
              integrationAttemptId: integration.id,
              ...delivered,
              runId: input.runId,
            });
            const worker = findDelegationForGoal(deps, input.goalId, workerDelegationRequestId);
            if (worker?.resultSummary) {
              getTaskRegistry(input.state, input.goalId).recordOutcome(taskId, worker.resultSummary);
            }
            const changeRegistry = getChangeRegistry(input.state, input.goalId);
            const change = changeRegistry.findChangeByTask(taskId);
            if (change) changeRegistry.recordMerged(change.id);
            const specMerge = completeSpecMergeAfterValidation(
              deps, input, taskId, workerDelegationRequestId, changeRegistry,
            );
            if (!specMerge) tryArchiveActiveChange(deps, input);
            await continueAfterRecovery(rejudgeOutcome, `Resolved candidate committed: ${delivered.safeSummary}`);
          }),
        });
      }),
    });
    return true;
  } catch (error) {
    const safeSummary = error instanceof Error ? error.message : "Integrator dispatch failed.";
    const current = tasks.getIntegration(integration.id);
    if (current && ["pending", "resolving"].includes(current.status)) {
      tasks.transitionIntegration(integration.id, "resolution_failed", { safeSummary, runId: input.runId });
    }
    await cleanup();
    return false;
  }
}

function findDelegationForGoal(
  deps: AgentSessionManagerDeps,
  goalId: string,
  delegationRequestId: string,
) {
  return deps.agentSessionRepo
    .listSessionsForGoal(goalId)
    .flatMap((session) => deps.agentSessionRepo.listDelegationRequests(session.id))
    .find((request) => request.id === delegationRequestId) ?? null;
}

/**
 * Pre-merge gate for spec-writer results: validate the OpenSpec artifacts in
 * the worker's worktree and convert failures into a substantive rejection
 * citing the frozen S1–S3 criteria. Returns the failure summary when the
 * result was rejected, null otherwise.
 */
/**
 * Backend-executed acceptance checks for a reviewed worker attempt: run each
 * checked criterion's command under backend authority and persist one durable
 * execution record per run. `red_green` checks execute against the baseline
 * first — a check that already passes there does not discriminate the change
 * and rejects the attempt; `regression` checks require a green baseline
 * (otherwise a contract-authoring error that charges nobody). A check that
 * cannot run fails closed. Returns the judge-packet appendix, or a rejection
 * reason that aborts the review dispatch.
 */
async function executeAcceptanceChecks(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  worker: {
    id: string;
    taskId?: string | null;
    childSessionId?: string | null;
    resultSummary?: { attestedFiles?: string[] | null } | null;
  },
): Promise<{ appendix: string | null; rejectReason: string | null }> {
  if (!deps.managedTaskRepo || !worker.taskId) return { appendix: null, rejectReason: null };
  const taskId = worker.taskId;
  const checked = deps.managedTaskRepo
    .listCriteria(input.goalId, taskId)
    .filter((criterion) => criterion.check);
  if (checked.length === 0) return { appendix: null, rejectReason: null };

  // Whoever must pass a check cannot edit it: an attested diff touching any
  // protected path rejects the attempt before a single check runs.
  const attested = new Set(
    (worker.resultSummary?.attestedFiles ?? []).map((path) => path.replaceAll("\\", "/")),
  );
  const touchedProtected = [...new Set(checked
    .flatMap((criterion) => criterion.check!.protectedPaths ?? [])
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => attested.has(path)))];
  if (touchedProtected.length > 0) {
    const reason =
      `Worker attempt ${worker.id} modified protected check paths: ${touchedProtected.join(", ")}. ` +
      `The party that must pass a check cannot edit it. The attempt is rejected; dispatch a corrective ` +
      `${taskId} attempt that leaves the protected paths untouched.`;
    reopenTaskForCheckViolation(deps, input, taskId, reason);
    return { appendix: null, rejectReason: reason };
  }

  const candidatePath = worker.childSessionId
    ? deps.agentSessionRepo.getSession(worker.childSessionId)?.worktree?.path ?? null
    : null;
  const runner = deps.checkRunner ?? createShellCheckRunner();

  // One ephemeral baseline worktree per review, at the base the worker
  // branched from (the supervisor's current HEAD).
  const needsBaseline = checked.some((criterion) => criterion.check!.kind !== "command");
  const worktreeService = deps.worktreeService ?? createGitWorktreeService();
  let baselinePath: string | null = null;
  if (needsBaseline) {
    try {
      const baseline = await worktreeService.createChildWorktree({
        parentCwd: input.state.supervisorCwd,
        childSessionId: `check-baseline-${worker.id}`,
      });
      baselinePath = baseline.path;
    } catch {
      baselinePath = null;
    }
  }

  const runAndRecord = async (
    criterion: (typeof checked)[number],
    target: "candidate" | "baseline",
    cwd: string | null,
  ) => {
    const check = criterion.check!;
    const result = cwd
      ? await runner.run({ cwd, command: check.command, timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS })
      : { exitCode: null, durationMs: 0, outputSummary: `${target} worktree unavailable; check could not run.`, failedToRun: true };
    const record = deps.managedTaskRepo!.recordCheckExecution({
      goalId: input.goalId,
      taskId,
      workerDelegationRequestId: worker.id,
      criterionId: criterion.criterionId,
      target,
      kind: check.kind,
      command: check.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputSummary: sanitizeArchiveReason(result.outputSummary || "(no output)", input.state.supervisorCwd).slice(0, 2000),
      failedToRun: result.failedToRun,
    });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: record.failedToRun
        ? `Acceptance check ${criterion.criterionId} [${check.kind}/${target}] for ${taskId} could not run.`
        : `Acceptance check ${criterion.criterionId} [${check.kind}/${target}] for ${taskId} exited ${record.exitCode} in ${record.durationMs}ms.`,
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: record.failedToRun ? "check.execution_failed" : "check.executed",
        taskId,
        workerDelegationRequestId: worker.id,
        criterionId: criterion.criterionId,
        checkKind: check.kind,
        target,
        exitCode: record.exitCode,
        durationMs: record.durationMs,
        safeReason: record.outputSummary.slice(0, 500),
      },
    });
    return record;
  };

  const lines = [
    "## Executed acceptance checks",
    "",
    "Backend-executed results for checked criteria (authoritative; your prose cannot override them):",
    "",
  ];
  const appendLine = (criterionId: string, kind: string, target: string, record: { failedToRun: boolean; exitCode: number | null; durationMs: number; outputSummary: string }) =>
    lines.push(
      `- ${criterionId} [${kind}/${target}] ` +
        `${record.failedToRun ? "FAILED TO RUN" : `exit ${record.exitCode}`} ` +
        `(${record.durationMs}ms): ${record.outputSummary.slice(0, 300)}`,
    );

  let rejectReason: string | null = null;
  try {
    for (const criterion of checked) {
      const check = criterion.check!;
      if (check.kind === "red_green" || check.kind === "regression") {
        const baseline = await runAndRecord(criterion, "baseline", baselinePath);
        appendLine(criterion.criterionId, check.kind, "baseline", baseline);
        if (check.kind === "red_green") {
          if (baseline.failedToRun) {
            rejectReason =
              `Acceptance check ${criterion.criterionId} (red_green) could not run on the baseline, so its ` +
              "discrimination cannot be verified. Fix the check environment before requesting review-merge.";
            break;
          }
          if (baseline.exitCode === 0) {
            reopenTaskForCheckViolation(deps, input, taskId,
              `Acceptance check ${criterion.criterionId} passed on the baseline (exit 0), so it does not ` +
              "discriminate this change.");
            rejectReason =
              `Acceptance check ${criterion.criterionId} (red_green) already passes on the baseline, so it does not ` +
              "discriminate this change — the test is vacuous or unrelated. The attempt is rejected; dispatch a " +
              `corrective ${taskId} attempt whose check fails before the change and passes after it.`;
            break;
          }
        } else if (baseline.failedToRun || baseline.exitCode !== 0) {
          rejectReason =
            `Acceptance check ${criterion.criterionId} (regression) fails on the baseline, which is a ` +
            "contract-authoring error: a regression check must be green before the change. The worker attempt is " +
            "untouched and its budget is not charged; split the task to author a correct contract.";
          break;
        }
      }
      const candidate = await runAndRecord(criterion, "candidate", candidatePath);
      appendLine(criterion.criterionId, check.kind, "candidate", candidate);
    }
  } finally {
    if (baselinePath) {
      void worktreeService
        .removeWorktree({ parentCwd: input.state.supervisorCwd, path: baselinePath })
        .catch(() => undefined);
    }
  }
  if (rejectReason) return { appendix: null, rejectReason };
  return { appendix: lines.join("\n"), rejectReason: null };
}

/**
 * For checked criteria the executed outcome is authoritative: a disagreeing
 * judge decision is overridden with a durable event naming both, and an
 * accepted verdict over any executed FAIL downgrades to a rejection.
 */
function enforceExecutedCheckOutcomes(
  deps: AgentSessionManagerDeps & { managedTaskRepo: ManagedTaskRepository },
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
  verdict: string,
): string | null {
  const taskId = outcome.workerTaskId!;
  const workerDelegationRequestId = outcome.workerDelegationRequestId!;
  const latestByCriterion = new Map<string, ReturnType<ManagedTaskRepository["listCheckExecutions"]>[number]>();
  for (const execution of deps.managedTaskRepo.listCheckExecutions(workerDelegationRequestId)) {
    if (execution.target === "candidate") latestByCriterion.set(execution.criterionId, execution);
  }
  if (latestByCriterion.size === 0) return null;

  let anyExecutedFail = false;
  for (const [criterionId, execution] of latestByCriterion) {
    const executedPass = !execution.failedToRun && execution.exitCode === 0;
    if (!executedPass) anyExecutedFail = true;
    const judge = outcome.reviewDecision?.decisions.find((decision) => decision.criterionId === criterionId);
    if (judge && (judge.outcome === "PASS") !== executedPass) {
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "agent.progress",
        message: `Judge decision for ${criterionId} overridden by the executed check result.`,
        data: {
          sessionId: input.sessionId,
          provider: input.providerId,
          model: input.modelLabel,
          runtimeEventType: "check.judge_overridden",
          taskId,
          workerDelegationRequestId,
          criterionId,
          judgeOutcome: judge.outcome,
          executedExitCode: execution.exitCode,
          executedFailedToRun: execution.failedToRun,
        },
      });
    }
  }
  if (verdict !== "accepted" || !anyExecutedFail) return null;

  const safeReason =
    `Executed acceptance checks failed for task ${taskId} even though the judge accepted the attempt; ` +
    "executed outcomes are authoritative for checked criteria. The attempt is rejected — dispatch a corrective " +
    "attempt that makes the checks pass.";
  deps.managedTaskRepo.recordDelivery({
    goalId: input.goalId,
    taskId,
    workerDelegationRequestId,
    status: "rejected",
    safeSummary: safeReason,
    runId: input.runId,
  });
  getTaskRegistry(input.state, input.goalId).markFailed(taskId);
  return safeReason;
}

/** A check violation reopens the attempt so a corrective one can dispatch. */
function reopenTaskForCheckViolation(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  taskId: string,
  safeSummary: string,
): void {
  const durableTask = deps.managedTaskRepo?.getTask(input.goalId, taskId);
  if (durableTask && ["awaiting_review", "awaiting_delivery"].includes(durableTask.status)) {
    deps.managedTaskRepo!.transition(taskId, "rejected", {
      goalId: input.goalId,
      runId: input.runId,
      safeSummary,
    });
  }
  getTaskRegistry(input.state, input.goalId).markFailed(taskId);
}

/**
 * After a structurally valid spec worker result: durably request the
 * Supervisor's semantic review and return the continuation appendix carrying
 * the bounded artifact packet. Returns null for non-spec outcomes.
 */
function recordSpecReviewRequested(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
): string | null {
  if (outcome.role !== "worker" || !outcome.taskId || outcome.resultSummary.kind !== "success") {
    return null;
  }
  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  const change = changeRegistry.findChangeByTask(outcome.taskId);
  if (!change || specTaskId(change.id) !== outcome.taskId) return null;

  // The packet must show the worker's authored artifacts; substituting any
  // other workspace's content would have the Supervisor review the scaffold.
  const packet = outcome.worktreePath
    ? buildSpecReviewPacket({ cwd: outcome.worktreePath, changeId: change.id })
    : null;
  changeRegistry.markSpecReadyForReview(change.id, outcome.delegationRequestId);
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: "Validated spec artifacts are ready for Supervisor review.",
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "change.spec_review_requested",
      changeId: change.id,
      taskId: outcome.taskId,
      workerDelegationRequestId: outcome.delegationRequestId,
    },
  });
  return [
    "## Supervisor spec review request",
    "",
    `Change ID: ${change.id}`,
    `Worker delegation request ID: ${outcome.delegationRequestId}`,
    "Structural validation result: S1, S2, and S3 passed.",
    "",
    "## Bounded spec review packet",
    "",
    packet === null
      ? "(The worker worktree is unavailable; the authored artifacts could not be read.)"
      : packet || "(No projected spec markdown was found.)",
  ].join("\n");
}

function rejectInvalidSpecResult(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
  registry: GoalTaskRegistry,
): string | null {
  const taskId = outcome.taskId!;
  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  const change = changeRegistry.findChangeByTask(taskId);
  if (!change || specTaskId(change.id) !== taskId) {
    return null;
  }
  const validated = input.state.openSpec.validateChange({
    cwd: outcome.worktreePath ?? input.state.supervisorCwd,
    changeId: change.id,
  });
  if (validated.ok) {
    return null;
  }
  const verdict = registry.classifyVerdict(taskId, specValidationVerdict(validated.failures));
  registry.recordOutcome(taskId, {
    kind: "failure",
    safeSummary: `Spec artifacts failed validation: ${validated.failures.join("; ")}`.slice(0, 500),
  });
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: "Spec artifacts failed validation; result rejected.",
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "task.rejection_recorded",
      taskId,
      changeId: change.id,
      citedCriteria: verdict.citedCriteria,
      failures: validated.failures,
      rejectionCount: registry.getTask(taskId)?.substantiveRejections,
    },
  });
  return specValidationVerdict(validated.failures);
}

/**
 * Post-merge gate: a change leaves `specifying` only after its Supervisor-
 * approved spec attempt was review-merged and the merged artifacts validate
 * in the goal workspace. Returns true when the merge was for a spec task
 * (handled here). Validation failure durably reopens the accepted task so a
 * corrective attempt stays dispatchable; a gate mismatch after the merge is
 * recorded durably, never swallowed.
 */
function completeSpecMergeAfterValidation(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  workerTaskId: string,
  workerDelegationRequestId: string | null,
  changeRegistry: GoalChangeRegistry,
): boolean {
  const change = changeRegistry.findChangeByTask(workerTaskId);
  if (!change || specTaskId(change.id) !== workerTaskId) {
    return false;
  }
  if (change.status !== "specifying") {
    return true;
  }
  if (!workerDelegationRequestId ||
      !changeRegistry.gateSpecReviewMerge(change.id, workerDelegationRequestId).ok) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Merged spec artifacts for ${change.id} no longer match an approved attempt; change stays in specifying.`,
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "change.spec_merge_ungated",
        changeId: change.id,
        taskId: workerTaskId,
        workerDelegationRequestId,
      },
    });
    return true;
  }
  const validated = input.state.openSpec.validateChange({
    cwd: input.state.supervisorCwd,
    changeId: change.id,
  });
  if (!validated.ok) {
    const safeReason = specValidationVerdict(validated.failures);
    const durableTask = deps.managedTaskRepo?.getTask(input.goalId, workerTaskId);
    if (durableTask?.status === "accepted") {
      deps.managedTaskRepo!.rejectAfterPostMergeValidation(
        workerTaskId,
        safeReason,
        input.runId,
        input.goalId,
      );
    }
    getTaskRegistry(input.state, input.goalId).markFailed(workerTaskId);
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Merged spec artifacts for ${change.id} failed validation; change stays in specifying.`,
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "change.spec_validation_failed",
        changeId: change.id,
        taskId: workerTaskId,
        workerDelegationRequestId,
        failures: validated.failures,
        safeReason,
      },
    });
    return true;
  }
  changeRegistry.markSpecMerged(change.id);
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: `Spec artifacts for ${change.id} merged and validated; change is executing.`,
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "change.spec_merged",
      changeId: change.id,
      workerDelegationRequestId,
    },
  });
  return true;
}

/**
 * Archive the active change when its completion conditions hold: all
 * registered tasks delivered and no attested worker changes left unmerged.
 * Archiving activates the next planned change; an unmerged-evidence block is
 * recorded durably so stranded worktree output is never silently "done".
 */
function tryArchiveActiveChange(deps: AgentSessionManagerDeps, input: PersistRuntimeEventInput): void {
  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  if (!changeRegistry.hasPlan()) {
    return;
  }
  const active = changeRegistry.activeChange();
  if (!active || active.status === "specifying") {
    return;
  }
  const baseData = {
    sessionId: input.sessionId,
    provider: input.providerId,
    model: input.modelLabel,
  };
  const gate = deps.database && deps.managedTaskRepo
    ? durableArchiveGate(deps.database, input.goalId, active.id, active.taskIds)
    : changeRegistry.canArchive(active.id, getTaskRegistry(input.state, input.goalId));
  if (!gate.ok) {
    const gateTaskIds = "taskIds" in gate && Array.isArray(gate.taskIds)
      ? gate.taskIds.filter((taskId): taskId is string => typeof taskId === "string")
      : [];
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Change ${active.id} cannot archive yet.`,
      data: {
        ...baseData,
        runtimeEventType: "change.archive_blocked",
        changeId: active.id,
        blockerType: active.hasUnmergedAttestedChanges
          ? "unmerged_changes"
          : "blockerType" in gate ? gate.blockerType : "undelivered_task",
        ...(gateTaskIds.length > 0 ? { taskIds: gateTaskIds } : {}),
        ...("reasonCode" in gate && gate.reasonCode ? { reasonCode: gate.reasonCode } : {}),
        safeReason: gate.safeReason,
      },
    });
    return;
  }
  if (active.hasUnmergedAttestedChanges) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Change ${active.id} cannot archive yet.`,
      data: {
        ...baseData,
        runtimeEventType: "change.archive_blocked",
        changeId: active.id,
        blockerType: "unmerged_changes",
        safeReason: `Change ${active.id} has attested worker file changes that were never review-merged.`,
      },
    });
    return;
  }
  if (deps.database) {
    if (!input.state.openSpec.prepareArchive) {
      recordArchiveOutcome(deps, input, {
        changeId: active.id,
        runtimeEventType: "change.archive_blocked",
        blockerType: "archive_capability_unavailable",
        safeReason: "Durable archive preparation is unavailable; legacy archive execution is disabled for database-backed Goals.",
      });
      return;
    }
    completeDurableArchive(deps, deps.database, input, active.id);
    return;
  }
  let archived;
  try {
    archived = input.state.openSpec.archiveChange({
      cwd: input.state.supervisorCwd,
      changeId: active.id,
      date: new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    archived = {
      ok: false as const,
      safeReason: sanitizeArchiveReason(safeErrorMessage(error), input.state.supervisorCwd),
    };
  }
  if (!archived.ok) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Archiving change ${active.id} failed.`,
      data: {
        ...baseData,
        runtimeEventType: "change.archive_failed",
        changeId: active.id,
        safeReason: archived.safeReason,
      },
    });
    return;
  }
  changeRegistry.markArchived(active.id);
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: `Change ${active.id} archived.`,
    data: { ...baseData, runtimeEventType: "change.archived", changeId: active.id },
  });
  const next = changeRegistry.activeChange();
  if (next) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Change ${next.id} activated.`,
      data: { ...baseData, runtimeEventType: "change.activated", changeId: next.id },
    });
  }
}

function completeDurableArchive(
  deps: AgentSessionManagerDeps,
  database: AppDatabase,
  input: PersistRuntimeEventInput,
  changeId: string,
): void {
  const archiveRepo = deps.managedChangeArchiveRepo ?? createManagedChangeArchiveRepository(database);
  const date = new Date().toISOString().slice(0, 10);
  let operation = archiveRepo.get(input.goalId, changeId);
  if (!operation) {
    let prepared;
    try {
      prepared = input.state.openSpec.prepareArchive!({
        cwd: input.state.supervisorCwd,
        changeId,
        date,
      });
    } catch (error) {
      recordArchiveOutcome(deps, input, {
        changeId,
        runtimeEventType: "change.archive_failed",
        blockerType: "archive_operation_failed",
        safeReason: sanitizeArchiveReason(safeErrorMessage(error), input.state.supervisorCwd),
      });
      return;
    }
    if (!prepared.ok) {
      recordArchiveOutcome(deps, input, {
        changeId,
        runtimeEventType: "change.archive_blocked",
        blockerType: "archive_state_ambiguous",
        safeReason: sanitizeArchiveReason(prepared.safeReason, input.state.supervisorCwd),
      });
      return;
    }
    operation = archiveRepo.beginIntent({ goalId: input.goalId, changeId, ...prepared });
    deps.archiveFault?.("after_intent");
  }
  if (operation.status === "committed") {
    activateAfterDurableArchive(deps, input, changeId);
    return;
  }
  let archived;
  try {
    archived = input.state.openSpec.archiveChange({
      cwd: input.state.supervisorCwd,
      changeId,
      date: archiveDateFromTarget(operation.targetPath, changeId),
      sourcePath: operation.sourcePath,
      targetPath: operation.targetPath,
      manifestDigest: operation.manifestDigest,
      preArchiveHead: operation.preArchiveHead,
    });
  } catch (error) {
    const safeReason = sanitizeArchiveReason(safeErrorMessage(error), input.state.supervisorCwd);
    archiveRepo.markBlocked(input.goalId, changeId, [safeReason]);
    recordArchiveOutcome(deps, input, {
      changeId,
      runtimeEventType: "change.archive_failed",
      blockerType: "archive_operation_failed",
      safeReason,
    });
    return;
  }
  if (!archived.ok || !archived.archiveCommitSha) {
    const safeReason = sanitizeArchiveReason(
      archived.safeReason ?? "Archive result did not include a verified Git commit.",
      input.state.supervisorCwd,
    );
    archiveRepo.markBlocked(input.goalId, changeId, [safeReason]);
    recordArchiveOutcome(deps, input, {
      changeId,
      runtimeEventType: /ambiguous|mismatch|both|neither|multiple/i.test(safeReason)
        ? "change.archive_blocked"
        : "change.archive_failed",
      blockerType: /ambiguous|mismatch|both|neither|multiple/i.test(safeReason)
        ? "archive_state_ambiguous"
        : "archive_operation_failed",
      safeReason,
    });
    return;
  }
  deps.archiveFault?.("after_move");
  try {
    archiveRepo.finalize({
      goalId: input.goalId,
      changeId,
      archiveCommitSha: archived.archiveCommitSha,
      runId: input.runId,
      safeSummary: `Change ${changeId} archived by the backend.`,
    });
  } catch (error) {
    const safeReason = sanitizeArchiveReason(safeErrorMessage(error), input.state.supervisorCwd);
    archiveRepo.markBlocked(input.goalId, changeId, [safeReason]);
    recordArchiveOutcome(deps, input, {
      changeId,
      runtimeEventType: "change.archive_failed",
      blockerType: "archive_operation_failed",
      safeReason,
    });
    return;
  }
  deps.archiveFault?.("after_final_event");
  activateAfterDurableArchive(deps, input, changeId);
}

function activateAfterDurableArchive(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  changeId: string,
): void {
  const changeRegistry = getChangeRegistry(input.state, input.goalId);
  if (changeRegistry.getChange(changeId)?.status !== "archived") changeRegistry.markArchived(changeId);
  const next = changeRegistry.activeChange();
  if (!next) return;
  const alreadyActivated = deps.eventRepo.listForGoal(input.goalId).some((event) =>
    event.data.runtimeEventType === "change.activated" && event.data.changeId === next.id
  );
  if (!alreadyActivated) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: `Change ${next.id} activated.`,
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "change.activated",
        changeId: next.id,
      },
    });
  }
}

function reconcileDurableArchivesBeforeResume(
  deps: AgentSessionManagerDeps,
  state: SupervisorState,
  goalId: string,
): boolean {
  const archiveRepo = deps.managedChangeArchiveRepo ?? createManagedChangeArchiveRepository(deps.database!);
  const changeRegistry = getChangeRegistry(state, goalId);
  for (const operation of archiveRepo.listForGoal(goalId)) {
    let archived;
    try {
      archived = state.openSpec.archiveChange({
        cwd: state.supervisorCwd,
        changeId: operation.changeId,
        date: archiveDateFromTarget(operation.targetPath, operation.changeId),
        sourcePath: operation.sourcePath,
        targetPath: operation.targetPath,
        manifestDigest: operation.manifestDigest,
        preArchiveHead: operation.preArchiveHead,
        ...(operation.archiveCommitSha ? { archiveCommitSha: operation.archiveCommitSha } : {}),
      });
    } catch (error) {
      archived = {
        ok: false as const,
        safeReason: sanitizeArchiveReason(safeErrorMessage(error), state.supervisorCwd),
      };
    }
    const archiveSha = archived.archiveCommitSha;
    if (!archived.ok || !archiveSha
      || (operation.status === "committed" && operation.archiveCommitSha !== archiveSha)) {
      const safeReason = sanitizeArchiveReason(
        !archived.ok
          ? archived.safeReason ?? "Archive reconciliation failed."
          : operation.status === "committed" && operation.archiveCommitSha !== archiveSha
            ? `Committed archive SHA mismatch for change ${operation.changeId}.`
            : "Archive reconciliation did not verify a Git commit.",
        state.supervisorCwd,
      );
      if (operation.status !== "committed") {
        archiveRepo.markBlocked(goalId, operation.changeId, [safeReason]);
      }
      deps.eventRepo.create({
        goalId,
        type: "agent.progress",
        message: `Archive reconciliation for ${operation.changeId} is blocked.`,
        data: {
          runtimeEventType: "change.archive_blocked",
          changeId: operation.changeId,
          blockerType: "archive_state_ambiguous",
          safeReason,
          archiveOperationId: operation.id,
        },
      });
      return false;
    }
    if (operation.status !== "committed") {
      archiveRepo.finalize({
        goalId,
        changeId: operation.changeId,
        archiveCommitSha: archiveSha,
        runId: null,
        safeSummary: `Change ${operation.changeId} archive reconciled before resume.`,
      });
    }
    if (changeRegistry.getChange(operation.changeId)?.status !== "archived") {
      changeRegistry.markArchived(operation.changeId);
    }
    const next = changeRegistry.activeChange();
    if (next && !deps.eventRepo.listForGoal(goalId).some((event) =>
      event.data.runtimeEventType === "change.activated" && event.data.changeId === next.id
    )) {
      deps.eventRepo.create({
        goalId,
        type: "agent.progress",
        message: `Change ${next.id} activated after archive reconciliation.`,
        data: {
          runtimeEventType: "change.activated",
          changeId: next.id,
          archiveOperationId: operation.id,
          recovery: true,
        },
      });
    }
  }

  const active = changeRegistry.activeChange();
  if (!active || archiveRepo.get(goalId, active.id)) return true;
  if (!state.openSpec.prepareArchive) {
    const safeReason = "Durable archive preparation is unavailable; restart cannot prove a resumable archive state.";
    deps.goalRepo.updateStatus(goalId, "blocked", { completedAt: new Date().toISOString() });
    deps.eventRepo.create({
      goalId,
      type: "agent.progress",
      message: `Archive reconciliation for ${active.id} is blocked.`,
      data: {
        runtimeEventType: "change.archive_blocked",
        changeId: active.id,
        blockerType: "archive_capability_unavailable",
        safeReason,
        recovery: true,
      },
    });
    return false;
  }
  let prepared;
  try {
    prepared = state.openSpec.prepareArchive({
      cwd: state.supervisorCwd,
      changeId: active.id,
      date: new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    prepared = {
      ok: false as const,
      safeReason: sanitizeArchiveReason(safeErrorMessage(error), state.supervisorCwd),
    };
  }
  if (prepared.ok) return true;
  const safeReason = sanitizeArchiveReason(prepared.safeReason, state.supervisorCwd);
  deps.eventRepo.create({
    goalId,
    type: "agent.progress",
    message: `Unowned archive state for ${active.id} is ambiguous.`,
    data: {
      runtimeEventType: "change.archive_blocked",
      changeId: active.id,
      blockerType: "archive_state_ambiguous",
      safeReason,
    },
  });
  return false;
}

function recordArchiveOutcome(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  outcome: {
    changeId: string;
    runtimeEventType: "change.archive_blocked" | "change.archive_failed";
    blockerType: string;
    safeReason: string;
  },
): void {
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: `Archiving change ${outcome.changeId} did not complete.`,
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: outcome.runtimeEventType,
      changeId: outcome.changeId,
      blockerType: outcome.blockerType,
      safeReason: outcome.safeReason,
    },
  });
}

function archiveDateFromTarget(targetPath: string, changeId: string): string {
  const suffix = `-${changeId}`;
  const directory = targetPath.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return directory.endsWith(suffix) ? directory.slice(0, -suffix.length) : "invalid-recorded-date";
}

function sanitizeArchiveReason(reason: string, workspace: string): string {
  const normalizedWorkspace = workspace.replace(/\\/g, "/");
  return reason.replace(/\\/g, "/").split(normalizedWorkspace).join("<goal-workspace>")
    .replace(/\s+/g, " ").trim().slice(0, 500);
}

interface DurableArchiveGateFailure {
  ok: false;
  safeReason: string;
  blockerType: "invalid_split_lineage" | "undelivered_task";
  taskIds: string[];
  reasonCode?: string;
}

function durableArchiveGate(
  db: AppDatabase,
  goalId: string,
  changeId: string,
  registeredTaskIds: string[],
): { ok: true } | DurableArchiveGateFailure {
  const projection = evaluateDurableManagedTaskLineage(db, goalId);
  const seeded = new Set([
    ...registeredTaskIds,
    ...projection.tasks.filter((task) => task.changeId === changeId).map((task) => task.id),
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of projection.tasks) {
      if (task.parentTaskId && seeded.has(task.parentTaskId) && !seeded.has(task.id)) {
        seeded.add(task.id);
        changed = true;
      }
    }
  }
  const lineageGaps = [
    ...lineageGapsForChange(projection, changeId),
    ...projection.gaps.filter((gap) =>
      (gap.taskIds ?? (gap.taskId ? [gap.taskId] : [])).some((taskId) => seeded.has(taskId))
    ),
  ];
  if (lineageGaps.length > 0) {
    const gap = lineageGaps[0]!;
    return {
      ok: false,
      blockerType: "invalid_split_lineage",
      reasonCode: gap.reasonCode ?? "invalid_split_lineage",
      taskIds: [...new Set(gap.taskIds ?? (gap.taskId ? [gap.taskId] : []))].slice(0, 20),
      safeReason: gap.safeSummary,
    };
  }
  const durableIds = new Set(projection.tasks.map((task) => task.id));
  const missing = [...seeded].filter((taskId) => !durableIds.has(taskId));
  const undelivered = projection.tasks
    .filter((task) => seeded.has(task.id) && projection.leafTaskIds.includes(task.id) && task.status !== "accepted")
    .map((task) => task.id);
  const taskIds = [...new Set([...missing, ...undelivered])].sort().slice(0, 20);
  if (taskIds.length > 0) {
    return {
      ok: false,
      blockerType: "undelivered_task",
      taskIds,
      safeReason: `Change ${changeId} has undelivered tasks: ${taskIds.join(", ")}`,
    };
  }
  return { ok: true };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deterministic gap identity for the repeated-gap circuit breaker: the
 * sorted, deduplicated union of the gaps' validated refs. Prose summaries
 * never participate, so paraphrasing cannot evade the breaker. An empty
 * signature (legacy replayed gaps) never trips it.
 */
function reassessmentGapSignature(remainingGaps: ReassessmentGap[]): string {
  return [...new Set(remainingGaps.flatMap((gap) => gap.refs))].sort().join("|");
}

const NEW_SCOPE_REF = /^new:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Resolve every gap ref against the goal's durable artifacts: change ids
 * (any epoch), registered task ids, `openspec/specs` capability names, or a
 * `new:<kebab-case>` declaration. Unsatisfied reassessments must also
 * reference every blocked change — that scope has to be re-planned, not
 * forgotten. Returns a teaching rejection reason, or null when valid.
 */
function resolveReassessmentGapRefs(
  input: PersistRuntimeEventInput,
  reassessment: GoalReassessment,
  changeRegistry: GoalChangeRegistry,
): string | null {
  const changeIds = new Set(changeRegistry.listChanges().map((change) => change.id));
  const taskIds = new Set([
    ...getTaskRegistry(input.state, input.goalId).listTasks().map((task) => task.id),
    ...changeRegistry.listChanges().flatMap((change) => change.taskIds),
  ]);
  const specsRoot = resolvePath(input.state.supervisorCwd, "openspec", "specs");
  const capabilities = new Set(
    existsSync(specsRoot)
      ? readdirSync(specsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [],
  );
  for (const gap of reassessment.remainingGaps) {
    for (const ref of gap.refs) {
      if (changeIds.has(ref) || taskIds.has(ref) || capabilities.has(ref) || NEW_SCOPE_REF.test(ref)) continue;
      return (
        `Reassessment gap ref "${ref}" resolves to nothing durable. Valid refs: a change id from this ` +
        "goal's plan, a registered task id, a capability name under openspec/specs, or new:<kebab-case> " +
        "for genuinely new scope."
      );
    }
  }
  const referenced = new Set(reassessment.remainingGaps.flatMap((gap) => gap.refs));
  for (const blockedId of changeRegistry.blockedIds()) {
    if (!referenced.has(blockedId)) {
      return (
        `Blocked change ${blockedId} is unaccounted for: an unsatisfied reassessment must reference every ` +
        "blocked change in its remaining gaps so the scope is re-planned, not forgotten."
      );
    }
  }
  return null;
}

/**
 * Bounded macro loop (AC7): epoch budget exhaustion or a repeated-gap
 * signature escalates the goal to its caller as a durable input request in
 * `waiting_user`, instead of opening another epoch. Without the escalation
 * ledger this degrades visibly to the legacy terminal block.
 */
function blockGoalForMacroLoop(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  runtimeEventType: "supervisor.epoch_budget_exhausted" | "supervisor.reassessment_circuit_breaker",
  reason: string,
  reassessment: GoalReassessment,
): void {
  if (!deps.goalInputRequestRepo) {
    const finishedAt = new Date().toISOString();
    deps.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: finishedAt });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "goal.blocked",
      message: `Goal blocked: ${reason}`,
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType,
        safeReason: reason,
        goalSatisfied: reassessment.goalSatisfied,
        evidence: reassessment.evidence,
        remainingGaps: reassessment.remainingGaps,
        ...(reassessment.nextEpochRationale ? { nextEpochRationale: reassessment.nextEpochRationale } : {}),
      },
    });
    return;
  }
  escalateGoalForCallerInput(deps, input, {
    reasonCode: runtimeEventType === "supervisor.epoch_budget_exhausted"
      ? "epoch_budget_exhausted"
      : "reassessment_circuit_breaker",
    runtimeEventType,
    safeReason: reason,
    budgetName: "planning_epochs",
    budgetValue: effectiveBudget(deps, input.state, input.goalId, "planning_epochs"),
    evidence: reassessment.evidence,
    remainingGaps: reassessment.remainingGaps,
    extraData: {
      goalSatisfied: reassessment.goalSatisfied,
      ...(reassessment.nextEpochRationale ? { nextEpochRationale: reassessment.nextEpochRationale } : {}),
    },
  });
}

/**
 * Caller escalation: record the durable input request, make the transition
 * observable, and park the goal in the non-terminal `waiting_user` state. The
 * request row and its event are the escalation's source of truth — resume
 * works from durable state alone, long after this session is gone.
 */
function escalateGoalForCallerInput(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  request: {
    reasonCode: GoalInputRequestReason;
    runtimeEventType: string;
    safeReason: string;
    budgetName: GoalInputBudgetName;
    budgetValue: number;
    evidence: string[];
    remainingGaps: ReassessmentGap[];
    extraData?: Record<string, unknown>;
  },
): void {
  const allowedDecisions = allowedDecisionsForReason(request.reasonCode);
  const created = deps.goalInputRequestRepo!.createRequest({
    goalId: input.goalId,
    reasonCode: request.reasonCode,
    safeSummary: request.safeReason,
    payload: {
      budgetName: request.budgetName,
      budgetValue: request.budgetValue,
      evidence: request.evidence,
      remainingGaps: request.remainingGaps,
      allowedDecisions,
    },
  });
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "goal.input_requested",
    message: request.safeReason,
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: request.runtimeEventType,
      reasonCode: request.reasonCode,
      inputRequestId: created.id,
      allowedDecisions,
      budgetName: request.budgetName,
      budgetValue: request.budgetValue,
      safeReason: request.safeReason,
      evidence: request.evidence,
      remainingGaps: request.remainingGaps,
      ...request.extraData,
    },
  });
  deps.goalRepo.updateStatus(input.goalId, "waiting_user", {});
}

/**
 * Spec-budget exhaustion is change-terminal, never goal-terminal: block the
 * change durably and hand the supervisor the reassess-and-re-plan route. The
 * goal only ends through the macro-loop bounds or explicit completion.
 */
function blockChangeForSpecBudget(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  data: Record<string, unknown>,
  changeId: string,
): void {
  const reason = "spec authoring exhausted its retry budget";
  getChangeRegistry(input.state, input.goalId).markBlocked(changeId);
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: `Change ${changeId} blocked: ${reason}.`,
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "change.blocked",
      changeId,
      safeReason: reason,
    },
  });
  recordControlRejection(
    deps, input, data,
    `Change ${changeId} is blocked: ${reason}. The goal stays running — when every remaining ` +
      "change is archived or blocked, emit an unsatisfied managed_goal.reassessment that names the " +
      "blocked scope in its remaining gaps, then re-plan it in the next epoch under new change ids.",
  );
}

function recordControlRejection(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  data: Record<string, unknown>,
  safeReason: string,
): void {
  input.state.lastRejectionReasons.set(input.goalId, safeReason);
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: "Delegation request rejected.",
    data: {
      ...data,
      delegationControlEvent: undefined,
      runtimeEventType: "delegation.rejected",
      safeReason,
    },
  });
}

function recordCompletionRejection(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  data: Record<string, unknown>,
  safeReason: string,
  gaps: ManagedCompletionGap[],
): void {
  input.state.completionRequestsEvaluated.add(input.goalId);
  input.state.lastCompletionGaps.set(input.goalId, gaps.map((gap) => ({ ...gap })));
  recordControlRejection(deps, input, data, safeReason);
}

async function startCompletionlessContinuation(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  data: Record<string, unknown>,
): Promise<void> {
  const goal = deps.goalRepo.getById(input.goalId);
  if (!goal || ["completed", "failed", "blocked", "cancelled", "waiting_user"].includes(goal.status)) {
    return;
  }

  const count = input.state.completionlessContinuations.get(input.goalId) ?? 0;
  const continuationBudget = effectiveBudget(deps, input.state, input.goalId, "supervisor_continuations");
  if (count >= continuationBudget) {
    const completionRequestEvaluated = input.state.completionRequestsEvaluated.has(input.goalId);
    const completionGaps = input.state.lastCompletionGaps.get(input.goalId) ?? [];
    const reason = completionRequestEvaluated
      ? `Supervisor reached ${continuationBudget} continuations without reaching successful completion`
      : `Supervisor reached ${continuationBudget} continuations without a completion signal`;
    const sharedData = {
      ...data,
      delegationControlEvent: undefined,
      maxSupervisorContinuations: continuationBudget,
      completionRequestEvaluated,
      ...(completionGaps.length > 0 ? { completionGaps } : {}),
      reason,
    };
    if (!deps.goalInputRequestRepo) {
      deps.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: new Date().toISOString() });
      deps.eventRepo.create({
        goalId: input.goalId,
        runId: input.runId,
        type: "goal.blocked",
        message: reason,
        data: { ...sharedData, runtimeEventType: "supervisor.continuations_exhausted" },
      });
      return;
    }
    escalateGoalForCallerInput(deps, input, {
      reasonCode: "continuation_exhausted",
      runtimeEventType: "supervisor.continuations_exhausted",
      safeReason: reason,
      budgetName: "supervisor_continuations",
      budgetValue: continuationBudget,
      evidence: completionGaps.map((gap) => gap.safeSummary),
      remainingGaps: [],
      extraData: sharedData,
    });
    return;
  }
  input.state.completionlessContinuations.set(input.goalId, count + 1);

  const rejectionReason = input.state.lastRejectionReasons.get(input.goalId);
  input.state.lastRejectionReasons.delete(input.goalId);
  const prompt = buildSupervisorPrompt({
    goal,
    phase: rejectionReason ? { kind: "rejection", safeReason: rejectionReason } : { kind: "nudge" },
    taskHistory: getTaskRegistry(input.state, input.goalId).listTasks(),
    managedTaskContext: deps.managedTaskRepo
      ? projectManagedTaskContext(deps.managedTaskRepo, input.goalId)
      : undefined,
    changeHistory: getChangeRegistry(input.state, input.goalId).listChanges(),
    epochHistory: getChangeRegistry(input.state, input.goalId).listEpochs(),
  });

  const run = deps.runRepo.create({
    goalId: input.goalId,
    provider: input.providerId,
    model: input.modelLabel ?? "unknown",
  });
  const session = deps.agentSessionRepo.createSession({
    goalId: input.goalId,
    runId: run.id,
    providerId: input.providerId,
    modelLabel: input.modelLabel,
    lifecycleState: "starting",
    capabilities: await input.adapter.detectCapabilities(),
  });
  const handle = await input.adapter.startSession({
    sessionId: session.id,
    goalId: input.goalId,
    runId: run.id,
    providerId: input.providerId,
    modelLabel: input.modelLabel,
    prompt,
  });
  input.activeHandles.set(session.id, handle);
  deps.agentSessionRepo.updateLifecycleState(session.id, "running");
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: run.id,
    type: "agent.progress",
    message: "Supervisor continuation started.",
    data: {
      sessionId: session.id,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "delegation.continuation_started",
      continuationMode: "fresh",
      continuationReason: rejectionReason ? "control_rejected" : "completionless_exit",
    },
  });
  void runSessionEvents(deps, {
    ...input,
    runId: run.id,
    sessionId: session.id,
    handle,
  });
}

async function continueSupervisorAfterChild(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  observation: string,
  metadata: { delegationRequestId: string; childSessionId: string },
): Promise<void> {
  const message = `Worker result: ${observation}`;
  const handle = input.activeHandles.get(input.sessionId);
  if (handle?.capabilities.resume) {
    await handle.send({ type: "resume", message });
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "running");
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: "Supervisor continuation started.",
      data: {
        sessionId: input.sessionId,
        provider: input.providerId,
        model: input.modelLabel,
        runtimeEventType: "delegation.continuation_started",
        continuationMode: "resume",
        ...metadata,
      },
    });
    return;
  }

  const run = deps.runRepo.create({
    goalId: input.goalId,
    provider: input.providerId,
    model: input.modelLabel ?? "unknown",
  });
  const session = deps.agentSessionRepo.createSession({
    goalId: input.goalId,
    runId: run.id,
    providerId: input.providerId,
    modelLabel: input.modelLabel,
    lifecycleState: "starting",
    capabilities: await input.adapter.detectCapabilities(),
  });
  const goal = deps.goalRepo.getById(input.goalId);
  const freshHandle = await input.adapter.startSession({
    sessionId: session.id,
    goalId: input.goalId,
    runId: run.id,
    providerId: input.providerId,
    modelLabel: input.modelLabel,
    prompt: goal
      ? buildSupervisorPrompt({
          goal,
          phase: { kind: "continuation", observation },
          taskHistory: getTaskRegistry(input.state, input.goalId).listTasks(),
          managedTaskContext: deps.managedTaskRepo
            ? projectManagedTaskContext(deps.managedTaskRepo, input.goalId)
            : undefined,
          changeHistory: getChangeRegistry(input.state, input.goalId).listChanges(),
          epochHistory: getChangeRegistry(input.state, input.goalId).listEpochs(),
        })
      : message,
  });
  input.activeHandles.set(session.id, freshHandle);
  deps.agentSessionRepo.updateLifecycleState(session.id, "running");
  const replacedSession = deps.agentSessionRepo.getSession(input.sessionId);
  if (replacedSession && !["cancelled", "failed", "completed"].includes(replacedSession.lifecycleState)) {
    // The fresh continuation session supersedes the exited supervisor session;
    // close the old one out so restart recovery does not mark it stalled.
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "completed");
  }
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: run.id,
    type: "agent.progress",
    message: "Supervisor continuation started.",
    data: {
      sessionId: session.id,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "delegation.continuation_started",
      continuationMode: "fresh",
      ...metadata,
    },
  });
  void runSessionEvents(deps, {
    ...input,
    runId: run.id,
    sessionId: session.id,
    handle: freshHandle,
  });
}

function runtimeEventTypeToEventType(type: AgentRuntimeEvent["type"]) {
  if (type === "command.started") return "agent.command.started";
  if (type === "command.completed") return "agent.command.completed";
  if (type === "command.failed") return "agent.command.failed";
  return "agent.progress";
}

function runtimeCommandKey(sessionId: string, runtimeCommandId: string): string {
  return `${sessionId}:${runtimeCommandId}`;
}

function clearRuntimeCommandIds(commandIds: Map<string, string>, sessionId: string): void {
  for (const key of commandIds.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      commandIds.delete(key);
    }
  }
}
