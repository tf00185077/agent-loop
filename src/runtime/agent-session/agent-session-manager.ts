import type {
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
import { createDelegationCoordinator } from "./delegation-coordinator.js";
import { validateDelegationControlEvent } from "./delegation-control-event.js";
import type { WorktreeService } from "./worktree-service.js";

export interface AgentSessionManagerDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  eventRepo: EventRepository;
  agentSessionRepo: AgentSessionRepository;
  worktreeService?: WorktreeService;
  supervisorCwd?: string;
}

export interface StartManagedSessionInput {
  goalId: string;
  providerId: string;
  modelLabel: string | null;
  prompt: string;
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
        prompt: input.prompt,
      });
      activeHandles.set(session.id, handle);
      deps.agentSessionRepo.updateLifecycleState(session.id, "running");

      try {
        for await (const event of handle.events()) {
          await persistRuntimeEvent(deps, {
            event,
            goalId: goal.id,
            runId: run.id,
            sessionId: session.id,
            providerId: input.providerId,
            modelLabel: input.modelLabel,
            adapter: input.adapter,
            activeHandles,
            runtimeCommandIds,
          });
        }
      } finally {
        activeHandles.delete(session.id);
        clearRuntimeCommandIds(runtimeCommandIds, session.id);
      }

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

interface PersistRuntimeEventInput {
  event: AgentRuntimeEvent;
  goalId: string;
  runId: string;
  sessionId: string;
  providerId: string;
  modelLabel: string | null;
  adapter: AgentRuntimeAdapter;
  activeHandles: Map<string, AgentSessionHandle>;
  runtimeCommandIds: Map<string, string>;
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
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "completed");
    deps.runRepo.updateStatus(input.runId, "completed", { finishedAt });
    deps.goalRepo.updateStatus(input.goalId, "completed", { completedAt: finishedAt });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "run.completed",
      message: "Managed agent session completed",
      data,
    });
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "goal.completed",
      message: "Goal completed successfully",
      data: { ...data, goalId: input.goalId },
    });
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

  const validation = validateDelegationControlEvent({
    controlEvent: input.event.metadata?.delegationControlEvent,
    parentSession,
  });
  if (!validation.ok) {
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: "Delegation request rejected.",
      data: {
        ...data,
        delegationControlEvent: undefined,
        runtimeEventType: "delegation.rejected",
        safeReason: validation.safeReason,
      },
    });
    return;
  }

  try {
    await createDelegationCoordinator(deps).acceptAndStartWorker({
      parentSessionId: input.sessionId,
      providerId: input.providerId,
      modelLabel: input.modelLabel,
      role: validation.request.role,
      prompt: validation.request.prompt,
      promptSummary: validation.request.promptSummary,
      workerDelegationRequestId: validation.request.workerDelegationRequestId,
      adapter: input.adapter,
      eventData: data,
      onChildOutcome: (outcome) => continueSupervisorAfterChild(deps, input, outcome.observation, {
        delegationRequestId: outcome.delegationRequestId,
        childSessionId: outcome.childSessionId,
      }),
    });
  } catch (err) {
    const safeReason = err instanceof Error ? err.message : "Delegation request rejected.";
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
  const freshHandle = await input.adapter.startSession({
    sessionId: session.id,
    goalId: input.goalId,
    runId: run.id,
    providerId: input.providerId,
    modelLabel: input.modelLabel,
    prompt: message,
  });
  input.activeHandles.set(session.id, freshHandle);
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
      ...metadata,
    },
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
