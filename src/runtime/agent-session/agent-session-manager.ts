import type {
  AgentAssignableRole,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeSession,
  AgentSessionHandle,
} from "../../domain/index.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type {
  AgentSessionRepository,
  EventRepository,
  RunRepository,
} from "../../persistence/runtime-repositories.js";
import { GoalChangeRegistry, specTaskAcceptance, specTaskId } from "./change-registry.js";
import { createDelegationCoordinator, type SupervisorContinuationInput } from "./delegation-coordinator.js";
import { validateManagedControlEvent } from "./delegation-control-event.js";
import {
  createOpenSpecWorkspaceService,
  type OpenSpecWorkspaceService,
} from "./openspec-workspace-service.js";
import { buildSupervisorPrompt } from "./supervisor-prompt.js";
import { GoalTaskRegistry } from "./task-registry.js";
import type { ReviewMergeVerificationService } from "./review-merge-verification-service.js";
import type { ReviewMergeWorkspaceService } from "./review-merge-workspace-service.js";
import type { WorktreeAttestor, WorktreeService } from "./worktree-service.js";

export interface AgentSessionManagerDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  eventRepo: EventRepository;
  agentSessionRepo: AgentSessionRepository;
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
  adapter: AgentRuntimeAdapter;
}

export interface StartManagedSessionResult {
  session: AgentRuntimeSession;
}

export interface AgentSessionManager {
  startManagedSession(input: StartManagedSessionInput): Promise<StartManagedSessionResult>;
  recoverOrphanedSessions(): AgentRuntimeSession[];
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

  return {
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
      for (const session of deps.agentSessionRepo.listNonTerminalSessions()) {
        const stalled = deps.agentSessionRepo.updateLifecycleState(session.id, "stalled");
        const finishedAt = new Date().toISOString();
        deps.runRepo.updateStatus(session.runId, "failed", {
          finishedAt,
          error: "Managed agent session lost adapter control.",
        });
        deps.goalRepo.updateStatus(session.goalId, "failed", { completedAt: finishedAt });
        deps.eventRepo.create({
          goalId: session.goalId,
          runId: session.runId,
          type: "error",
          message: "Managed agent session lost adapter control during backend restart.",
          data: {
            sessionId: session.id,
            provider: session.providerId,
            model: session.modelLabel,
            recoveryState: "stalled",
          },
        });
        recovered.push(stalled);
      }

      return recovered;
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
  try {
    for await (const event of input.handle.events()) {
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
    if (changeResolution.changeId) {
      for (const task of validation.tasks) {
        changeRegistry.registerTask(changeResolution.changeId, task.id);
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
    const finishedAt = new Date().toISOString();
    input.state.completedGoals.add(input.goalId);
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
  if (changeResolution.changeId && validation.request.taskId) {
    changeRegistry.registerTask(changeResolution.changeId, validation.request.taskId);
  }

  const registry = getTaskRegistry(input.state, input.goalId);
  let dispatchAcceptance = validation.request.acceptance ?? null;
  let uncontracted = false;
  if (validation.request.role === "worker") {
    const task = validation.request.taskId ? registry.getTask(validation.request.taskId) : undefined;
    if (task && task.attemptCount > 0) {
      // Re-delegating a task implies its previous attempt was rejected. The
      // rejection is substantive only when the supervisor cites frozen
      // criterion ids; otherwise it is just the next attempt.
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
      recordControlRejection(deps, input, data, gate.safeReason);
      return;
    }
    dispatchAcceptance = gate.acceptance;
    uncontracted = gate.uncontracted;
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
      workerDelegationRequestId: validation.request.workerDelegationRequestId,
      adapter: childAgent.adapter,
      eventData: { ...data, ...(uncontracted ? { uncontracted: true } : {}) },
      onChildOutcome: async (outcome) => {
        recordChildOutcomeInRegistry(deps, input, outcome);
        await continueSupervisorAfterChild(deps, input, outcome.observation, {
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
  role: "worker" | "review_merge",
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

function recordChildOutcomeInRegistry(
  deps: AgentSessionManagerDeps,
  input: PersistRuntimeEventInput,
  outcome: SupervisorContinuationInput,
): void {
  const registry = getTaskRegistry(input.state, input.goalId);
  if (outcome.role === "worker" && outcome.taskId) {
    registry.recordOutcome(outcome.taskId, outcome.resultSummary);
    return;
  }
  if (outcome.role !== "review_merge" || !outcome.workerTaskId) {
    return;
  }
  const rejecting =
    (outcome.reviewMergeOutcome !== null && REVIEW_REJECTION_OUTCOMES.has(outcome.reviewMergeOutcome)) ||
    outcome.resultSummary.kind === "failure";
  if (!rejecting) {
    return;
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
    return;
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
