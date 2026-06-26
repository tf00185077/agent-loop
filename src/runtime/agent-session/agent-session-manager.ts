import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeSession,
} from "../../domain/index.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type {
  AgentSessionRepository,
  EventRepository,
  RunRepository,
} from "../../persistence/runtime-repositories.js";

export interface AgentSessionManagerDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  eventRepo: EventRepository;
  agentSessionRepo: AgentSessionRepository;
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
}

export function createAgentSessionManager(deps: AgentSessionManagerDeps): AgentSessionManager {
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
      deps.agentSessionRepo.updateLifecycleState(session.id, "running");

      for await (const event of handle.events()) {
        persistRuntimeEvent(deps, {
          event,
          goalId: goal.id,
          runId: run.id,
          sessionId: session.id,
          providerId: input.providerId,
          modelLabel: input.modelLabel,
        });
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
  };
}

interface PersistRuntimeEventInput {
  event: AgentRuntimeEvent;
  goalId: string;
  runId: string;
  sessionId: string;
  providerId: string;
  modelLabel: string | null;
}

function persistRuntimeEvent(deps: AgentSessionManagerDeps, input: PersistRuntimeEventInput): void {
  const data = {
    sessionId: input.sessionId,
    provider: input.providerId,
    model: input.modelLabel,
    ...input.event.metadata,
  };

  if (input.event.type === "approval.requested") {
    deps.agentSessionRepo.updateLifecycleState(input.sessionId, "waiting_approval");
    deps.eventRepo.create({
      goalId: input.goalId,
      runId: input.runId,
      type: "agent.progress",
      message: input.event.message,
      data: { ...data, runtimeEventType: input.event.type },
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

  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: runtimeEventTypeToEventType(input.event.type),
    message: input.event.message,
    data: { ...data, runtimeEventType: input.event.type },
  });
}

function runtimeEventTypeToEventType(type: AgentRuntimeEvent["type"]) {
  if (type === "command.started") return "agent.command.started";
  if (type === "command.completed") return "agent.command.completed";
  if (type === "command.failed") return "agent.command.failed";
  return "agent.progress";
}
