import type {
  AgentAssignableRole,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeSession,
  AgentSessionHandle,
} from "../../domain/index.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type { AppDatabase } from "../../persistence/database.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";
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
  openSpecWorkspaceService?: OpenSpecWorkspaceService;
  reviewMergeWorkspaceService?: ReviewMergeWorkspaceService;
  reviewMergeVerificationService?: ReviewMergeVerificationService;
  supervisorCwd?: string;
  /**
   * Maximum supervisor continuations started because a delegation-capable
   * session ended without a completion signal, per goal.
   */
  maxSupervisorContinuations?: number;
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

export interface AgentSessionManager {
  startManagedSession(input: StartManagedSessionInput): Promise<StartManagedSessionResult>;
  recoverOrphanedSessions(): AgentRuntimeSession[];
  reconcileOrphanedWorktrees(): Promise<void>;
  resumeInterruptedGoal(input: ResumeInterruptedGoalInput): Promise<void>;
  approve(sessionId: string, requestId: string): Promise<boolean>;
  reject(sessionId: string, requestId: string, reason?: string): Promise<boolean>;
  cancel(sessionId: string, reason?: string): Promise<boolean>;
}

export function createAgentSessionManager(deps: AgentSessionManagerDeps): AgentSessionManager {
  const activeHandles = new Map<string, AgentSessionHandle>();
  const deliveredControls = new Set<string>();
  const runtimeCommandIds = new Map<string, string>();
  const state: SupervisorState = {
    completedGoals: new Set(),
    completionlessContinuations: new Map(),
    lastRejectionReasons: new Map(),
    taskRegistries: new Map(),
    changeRegistries: new Map(),
    openspecDowngradeReported: new Set(),
    roleResolutions: new Map(),
    maxSupervisorContinuations: deps.maxSupervisorContinuations ?? 10,
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
        if (goal && ["interrupted", "completed", "failed", "blocked", "cancelled"].includes(goal.status)) continue;
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

      // Rehydrate the working caches from the durable ledger so the resumed
      // session gates and continues against the same state it had before the crash.
      if (deps.managedTaskRepo) {
        rehydrateTaskRegistry(getTaskRegistry(state, input.goalId), deps.managedTaskRepo, input.goalId);
        rehydrateChangeRegistry(
          getChangeRegistry(state, input.goalId),
          deps.managedTaskRepo,
          input.goalId,
          deps.eventRepo.listForGoal(input.goalId),
        );
      }

      const continuationPrompt = buildSupervisorPrompt({
        goal,
        phase: { kind: "continuation", observation: "Resumed after backend restart." },
        taskHistory: getTaskRegistry(state, input.goalId).listTasks(),
        managedTaskContext: deps.managedTaskRepo
          ? projectManagedTaskContext(deps.managedTaskRepo, input.goalId)
          : undefined,
        changeHistory: getChangeRegistry(state, input.goalId).listChanges(),
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
        message: "Interrupted goal resumed from durable projection.",
        data: {
          runtimeEventType: "recovery.resumed",
          provider: input.providerId,
          model: input.modelLabel,
          providerResume: Boolean(resumeSessionId),
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

    cancel(sessionId, reason) {
      return deliverControl(activeHandles, deliveredControls, sessionId, "cancel", (handle) => handle.cancel(reason));
    },
  };

  return manager;
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

  // 1. Reset every pending delivery to its recorded clean checkpoint so git and
  //    the ledger agree and no candidate is double-applied or left unvalidated.
  for (const delivery of deps.managedTaskRepo?.listPendingDeliveries(goalId) ?? []) {
    if (!delivery.checkpointHead || !deliveryService.reconcilePendingDelivery) continue;
    deliveryService.reconcilePendingDelivery({ supervisorCwd: state.supervisorCwd, checkpointHead: delivery.checkpointHead });
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
    if (attempt.taskId && deps.managedTaskRepo?.getTask(attempt.taskId)) {
      deps.managedTaskRepo.resetTaskForReDispatch(attempt.taskId, runId);
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
  /** Per-goal count of continuations started because a session ended without completing. */
  completionlessContinuations: Map<string, number>;
  /** Per-goal safe reason of the most recent rejected control block. */
  lastRejectionReasons: Map<string, string>;
  /** Per-goal frozen acceptance-contract registry. */
  taskRegistries: Map<string, GoalTaskRegistry>;
  /** Per-goal change-plan registry. */
  changeRegistries: Map<string, GoalChangeRegistry>;
  /** Goals whose openspec degraded mode was already reported. */
  openspecDowngradeReported: Set<string>;
  /** Per goal+role resolved child agent (null = use the goal default). */
  roleResolutions: Map<string, ResolvedRoleAgentLike | null>;
  maxSupervisorContinuations: number;
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
  } finally {
    input.activeHandles.delete(input.sessionId);
    clearRuntimeCommandIds(input.runtimeCommandIds, input.sessionId);
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
    const registered = registry.registerTaskList(validation.tasks);
    deps.managedTaskRepo?.registerTasks({
      goalId: input.goalId,
      changeId: changeResolution.changeId,
      runId: input.runId,
      tasks: validation.tasks,
    });
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
      if (!completionChangeRegistry.allArchived()) {
        recordControlRejection(
          deps,
          input,
          data,
          `Planned changes remain unarchived: ${completionChangeRegistry.unarchivedIds().join(", ")}. ` +
            "Deliver, merge, and archive them before completing the goal.",
        );
        return;
      }
    }
    if (deps.database && deps.managedTaskRepo) {
      const evaluated = evaluateManagedCompletion(deps.database, {
        goalId: input.goalId,
        unarchivedChangeIds: completionChangeRegistry.hasPlan() ? completionChangeRegistry.unarchivedIds() : [],
      });
      if (!evaluated.ok) {
        recordControlRejection(
          deps,
          input,
          { ...data, completionGaps: evaluated.gaps },
          `Completion blocked by durable gaps: ${evaluated.gaps.map((gap) => gap.safeSummary).join(" ")}`.slice(0, 1000),
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
    return;
  }

  if (validation.kind === "change_plan") {
    const changeRegistry = getChangeRegistry(input.state, input.goalId);
    const planGate = changeRegistry.registerPlan(validation.plan.changes);
    if (!planGate.ok) {
      recordControlRejection(deps, input, data, planGate.safeReason);
      return;
    }

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

    const orderedChanges = changeRegistry.listChanges();
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

    const specTasks = orderedChanges.map((change) => ({
      taskId: specTaskId(change.id),
      changeId: change.id,
      acceptance: specTaskAcceptance(change.id),
    }));
    getTaskRegistry(input.state, input.goalId).registerTaskList(
      specTasks.map((task) => ({
        id: task.taskId,
        title: `Author OpenSpec artifacts for change ${task.changeId}`,
        acceptance: task.acceptance,
        parentTaskId: null,
      })),
    );
    deps.managedTaskRepo?.registerTasks({
      goalId: input.goalId,
      runId: input.runId,
      tasks: specTasks.map((task) => ({
        id: task.taskId,
        title: `Author OpenSpec artifacts for change ${task.changeId}`,
        acceptance: task.acceptance,
        parentTaskId: null,
      })),
    });

    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: "Supervisor change plan recorded.",
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: "supervisor.change_plan",
        changePlan: validation.plan.changes,
        specTasks,
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
        ? deps.managedTaskRepo.getTask(validation.request.taskId)
        : null;
      if (!durableTask) {
        uncontracted = true;
      } else {
        const criteria = deps.managedTaskRepo.listCriteria(durableTask.id);
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
          if (durableTask.status !== "accepted") {
            deps.managedTaskRepo.transition(durableTask.id, "split", {
              safeSummary: `Task ${durableTask.id} exhausted its retry budget and must be narrowed.`,
              runId: input.runId,
              citedCriteria: durableTask.lastCitedCriteria,
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
        // Exhausting the spec budget blocks the change — and the goal (v1).
        blockChangeAndGoal(deps, input, specChange.id, "spec authoring exhausted its retry budget");
        return;
      }
      recordControlRejection(deps, input, data, gate.safeReason);
      return;
    }
    dispatchAcceptance = gate.acceptance;
    uncontracted = gate.uncontracted;
    }
  }

  const childAgent = await resolveChildAgent(deps, input, validation.request.role);

  try {
    await createDelegationCoordinator(deps).acceptAndStartWorker({
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
          })
        : null,
      workerDelegationRequestId: validation.request.workerDelegationRequestId,
      adapter: childAgent.adapter,
      eventData: { ...data, ...(uncontracted ? { uncontracted: true } : {}) },
      onChildOutcome: async (outcome) => {
        const backendRejection = await recordChildOutcomeInRegistry(deps, input, outcome);
        if (backendRejection === CONDITIONAL_RECOVERY_DEFERRED) return;
        // Fresh continuations are new sessions with no memory of delegation
        // ids; the observation must carry the id a later review-merge request
        // will reference.
        const taggedObservation =
          outcome.role === "worker"
            ? `${outcome.observation} [workerDelegationRequestId: ${outcome.delegationRequestId}]`
            : outcome.observation;
        const observation = backendRejection
          ? `${taggedObservation}\n\nBackend validation rejected this result. Failing checks: ${backendRejection}`
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
      const specMerge = approveSpecChangeAfterMerge(deps, input, outcome.workerTaskId, changeRegistry);
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
  if (outcome.role === "worker" && outcome.taskId && tasks.getTask(outcome.taskId)) {
    if (outcome.resultSummary.kind === "success") {
      tasks.recordExecutorEvidence({
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

  if (attestedFiles.length > 0) {
    if (!outcome.worktreePath) {
      tasks.recordDelivery({
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
    });
    if (!prepared.ok) {
      tasks.recordDelivery({
        taskId: outcome.workerTaskId,
        workerDelegationRequestId: outcome.workerDelegationRequestId,
        ...prepared.result,
        runId: input.runId,
      });
      return prepared.result.safeSummary;
    }
    // Write-ahead delivery intent (candidate + checkpoint) before the supervisor mutation.
    tasks.recordDelivery({
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
  const specMerge = approveSpecChangeAfterMerge(deps, input, outcome.workerTaskId, changeRegistry);
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
  const acceptance = tasks.listCriteria(taskId).map((criterion) => ({
    id: criterion.criterionId,
    text: criterion.text,
  }));
  const integration = tasks.beginIntegration({
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
    await createDelegationCoordinator(deps).acceptAndStartWorker({
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
        await createDelegationCoordinator(deps).acceptAndStartWorker({
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
            const specMerge = approveSpecChangeAfterMerge(deps, input, taskId, changeRegistry);
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
 * Post-merge gate: a change leaves `specifying` only after its spec-writer
 * result was review-merged and the merged artifacts validate in the goal
 * workspace. Returns true when the merge was for a spec task (handled here).
 */
function approveSpecChangeAfterMerge(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  workerTaskId: string,
  changeRegistry: GoalChangeRegistry,
): boolean {
  const change = changeRegistry.findChangeByTask(workerTaskId);
  if (!change || specTaskId(change.id) !== workerTaskId) {
    return false;
  }
  if (change.status !== "specifying") {
    return true;
  }
  const validated = input.state.openSpec.validateChange({
    cwd: input.state.supervisorCwd,
    changeId: change.id,
  });
  if (!validated.ok) {
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
        failures: validated.failures,
      },
    });
    return true;
  }
  changeRegistry.markSpecApproved(change.id);
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "agent.progress",
    message: `Spec artifacts for ${change.id} approved; change is executing.`,
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "change.spec_approved",
      changeId: change.id,
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
  const gate = changeRegistry.canArchive(active.id, getTaskRegistry(input.state, input.goalId));
  if (!gate.ok) {
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
          safeReason: gate.safeReason,
        },
      });
    }
    return;
  }
  const archived = input.state.openSpec.archiveChange({
    cwd: input.state.supervisorCwd,
    changeId: active.id,
    date: new Date().toISOString().slice(0, 10),
  });
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

/** v1 rule: a blocked change blocks the goal, durably and visibly. */
function blockChangeAndGoal(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  changeId: string,
  reason: string,
): void {
  getChangeRegistry(input.state, input.goalId).markBlocked(changeId);
  const finishedAt = new Date().toISOString();
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
  deps.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: finishedAt });
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "goal.blocked",
    message: `Goal blocked: change ${changeId} ${reason}.`,
    data: {
      sessionId: input.sessionId,
      provider: input.providerId,
      model: input.modelLabel,
      runtimeEventType: "goal.blocked",
      changeId,
      safeReason: reason,
    },
  });
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

async function startCompletionlessContinuation(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  data: Record<string, unknown>,
): Promise<void> {
  const goal = deps.goalRepo.getById(input.goalId);
  if (!goal || ["completed", "failed", "blocked"].includes(goal.status)) {
    return;
  }

  const count = input.state.completionlessContinuations.get(input.goalId) ?? 0;
  if (count >= input.state.maxSupervisorContinuations) {
    const finishedAt = new Date().toISOString();
    const reason = `Supervisor reached ${input.state.maxSupervisorContinuations} continuations without a completion signal`;
    deps.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: finishedAt });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "goal.blocked",
      message: reason,
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: "supervisor.continuations_exhausted",
        maxSupervisorContinuations: input.state.maxSupervisorContinuations,
        reason,
      },
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
