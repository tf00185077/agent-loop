import type {
  AgentRuntimeAdapter,
  AgentRuntimeDelegationRole,
  AgentRuntimeDelegationSummary,
  AgentRuntimeEvent,
  AgentRuntimeWorktreeMetadata,
} from "../../domain/index.js";
import type {
  AgentSessionRepository,
  EventRepository,
  RunRepository,
} from "../../persistence/runtime-repositories.js";
import { createGitWorktreeService, type WorktreeService } from "./worktree-service.js";

export interface DelegationCoordinatorDeps {
  runRepo: RunRepository;
  eventRepo: EventRepository;
  agentSessionRepo: AgentSessionRepository;
  worktreeService?: WorktreeService;
  supervisorCwd?: string;
}

export interface StartWorkerDelegationInput {
  parentSessionId: string;
  providerId: string;
  modelLabel: string | null;
  role: AgentRuntimeDelegationRole;
  prompt: string;
  promptSummary: string;
  workerDelegationRequestId?: string | null;
  adapter: AgentRuntimeAdapter;
  eventData: Record<string, unknown>;
  onChildOutcome?: (input: SupervisorContinuationInput) => Promise<void>;
}

export interface SupervisorContinuationInput {
  parentSessionId: string;
  delegationRequestId: string;
  childSessionId: string;
  observation: string;
}

export interface DelegationCoordinator {
  acceptAndStartWorker(input: StartWorkerDelegationInput): Promise<void>;
}

export function createDelegationCoordinator(deps: DelegationCoordinatorDeps): DelegationCoordinator {
  const worktreeService = deps.worktreeService ?? createGitWorktreeService();
  const supervisorCwd = deps.supervisorCwd ?? process.cwd();

  return {
    async acceptAndStartWorker(input) {
      const parent = deps.agentSessionRepo.getSession(input.parentSessionId);
      if (!parent) {
        throw new Error(`Agent session not found: ${input.parentSessionId}`);
      }
      const workerResult = input.role === "review_merge" ? requireWorkerResult(deps, parent.id, input.workerDelegationRequestId) : null;

      const request = deps.agentSessionRepo.createDelegationRequest({
        parentSessionId: parent.id,
        role: input.role,
        promptSummary: workerResult
          ? `${input.promptSummary} (worker result: ${workerResult.resultSummary.safeSummary})`
          : input.promptSummary,
      });
      const accepted = deps.agentSessionRepo.acceptDelegationRequest(request.id);
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
          : { path: supervisorCwd, worktree: null };
      const handle = await input.adapter.startSession({
        sessionId: childSession.id,
        goalId: parent.goalId,
        runId: childRun.id,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        prompt: input.prompt,
        parent: { sessionId: parent.id },
        cwd: childCwd.path,
      });

      const running = deps.agentSessionRepo.startDelegationRequest(accepted.id, childSession.id);
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
          ...(childCwd.worktree ? { worktree: childCwd.worktree } : {}),
          ...(workerResult ? { workerDelegationRequestId: workerResult.id } : {}),
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
          ...(childCwd.worktree ? { worktree: childCwd.worktree } : {}),
          ...(workerResult ? { workerDelegationRequestId: workerResult.id } : {}),
        },
      });

      void consumeChildEvents(deps, {
        events: handle.events(),
        delegationRequestId: running.id,
        childRunId: childRun.id,
        childSessionId: childSession.id,
        eventData: input.eventData,
        parentSessionId: parent.id,
        onChildOutcome: input.onChildOutcome,
      });
    },
  };
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
  parentSessionId: string,
  workerDelegationRequestId?: string | null,
) {
  const workerResult = deps.agentSessionRepo
    .listDelegationRequests(parentSessionId)
    .find((request) => request.id === workerDelegationRequestId && request.role === "worker" && request.resultSummary);
  if (!workerResult?.resultSummary) {
    throw new Error("Review merge requires an existing worker result.");
  }
  return {
    id: workerResult.id,
    resultSummary: workerResult.resultSummary,
  };
}

interface ConsumeChildEventsInput extends Omit<RecordChildEventInput, "event"> {
  events: AsyncIterable<AgentRuntimeEvent>;
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
  onChildOutcome?: (input: SupervisorContinuationInput) => Promise<void>;
}

interface ChildTerminalOutcome {
  observation: string;
  detached: boolean;
}

function recordChildEvent(deps: DelegationCoordinatorDeps, input: RecordChildEventInput): ChildTerminalOutcome | null {
  if (input.event.type === "session.completed") {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.childSessionId, "completed");
    deps.runRepo.updateStatus(input.childRunId, "completed", { finishedAt });
    const request = recordTerminalDelegation(deps, input, "completed", summary("success", input.event.message));
    recordDelegationOutcome(
      deps,
      input,
      request.id,
      request.status === "detached" ? "delegation.detached" : "delegation.completed",
      input.event.message,
    );
    return { observation: input.event.message, detached: request.status === "detached" };
  }
  if (input.event.type === "session.failed") {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.childSessionId, "failed");
    deps.runRepo.updateStatus(input.childRunId, "failed", { finishedAt, error: input.event.message });
    const request = recordTerminalDelegation(deps, input, "failed", summary("failure", input.event.message));
    recordDelegationOutcome(
      deps,
      input,
      request.id,
      request.status === "detached" ? "delegation.detached" : "delegation.failed",
      input.event.message,
    );
    return { observation: input.event.message, detached: request.status === "detached" };
  }
  if (input.event.type === "session.cancelled") {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.childSessionId, "cancelled");
    deps.runRepo.updateStatus(input.childRunId, "failed", { finishedAt, error: input.event.message });
    const request = recordTerminalDelegation(deps, input, "cancelled", summary("cancelled", input.event.message));
    recordDelegationOutcome(
      deps,
      input,
      request.id,
      request.status === "detached" ? "delegation.detached" : "delegation.cancelled",
      input.event.message,
    );
    return { observation: input.event.message, detached: request.status === "detached" };
  }
  if (input.event.type === "session.timed_out") {
    const finishedAt = new Date().toISOString();
    deps.agentSessionRepo.updateLifecycleState(input.childSessionId, "failed");
    deps.runRepo.updateStatus(input.childRunId, "failed", { finishedAt, error: input.event.message });
    const request = recordTerminalDelegation(deps, input, "timed_out", summary("timeout", input.event.message));
    recordDelegationOutcome(
      deps,
      input,
      request.id,
      request.status === "detached" ? "delegation.detached" : "delegation.timed_out",
      input.event.message,
    );
    return { observation: input.event.message, detached: request.status === "detached" };
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
