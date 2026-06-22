import type {
  Goal,
  ImplementerResult,
  PlannerResult,
  QuorumVoteResult,
  Step,
} from "../domain/index.js";
import type { GoalRepository } from "../persistence/goal-repository.js";
import type {
  EventRepository,
  RunRepository,
  StepRepository,
} from "../persistence/runtime-repositories.js";
import type { Implementer } from "./agent-implementer.js";
import type { Planner } from "./agent-planner.js";
import type { ModelProviderMetadata } from "./model-provider.js";
import { buildGateVotedEventData } from "./quorum-voters.js";

export interface CompletionGateInput {
  goal: Goal;
  step: Step;
  implementation: ImplementerResult;
}

export interface CompletionGate {
  vote(input: CompletionGateInput): Promise<QuorumVoteResult>;
}

export interface AgentLoopRuntimeDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  stepRepo: StepRepository;
  eventRepo: EventRepository;
  metadata: ModelProviderMetadata;
  maxSteps?: number;
  maxDepth?: number;
  runStartedMessage?: string;
  planner: Planner;
  implementer: Implementer;
  gate: CompletionGate;
}

export interface AgentLoopRuntime {
  run(goalId: string): Promise<void>;
}

export function createAgentLoopRuntime(deps: AgentLoopRuntimeDeps): AgentLoopRuntime {
  const { goalRepo, runRepo, stepRepo, eventRepo, metadata, planner, implementer, gate } = deps;
  const maxSteps = deps.maxSteps ?? 1;
  const maxDepth = deps.maxDepth ?? 0;
  const runStartedMessage = deps.runStartedMessage ?? "Agent loop run started";

  return {
    async run(goalId) {
      const goal = goalRepo.getById(goalId);
      if (!goal) throw new Error(`Goal not found: ${goalId}`);

      const run = runRepo.create({
        goalId,
        provider: metadata.provider,
        model: metadata.model,
      });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "run.started",
        message: runStartedMessage,
        data: {
          runId: run.id,
          provider: metadata.provider,
          model: metadata.model,
        },
      });

      let depth = 0;
      for (let order = 1; order <= maxSteps; order += 1) {
        const priorSteps = stepRepo.listForRun(run.id);
        const decision = await planner.plan({ goal, priorSteps });

        if (decision.decision === "DECOMPOSE") {
          eventRepo.create({
            goalId,
            runId: run.id,
            type: "agent.decision",
            message: `Planner decision: ${decision.decision}`,
            data: plannerDecisionData(decision),
          });
          if (depth >= maxDepth) {
            finishBounded({
              goalId,
              runId: run.id,
              bound: "maxDepth",
              value: maxDepth,
              goalRepo,
              runRepo,
              eventRepo,
            });
            return;
          }
          depth += 1;
          continue;
        }

        if (decision.decision === "BLOCKED") {
          eventRepo.create({
            goalId,
            runId: run.id,
            type: "agent.decision",
            message: `Planner decision: ${decision.decision}`,
            data: plannerDecisionData(decision),
          });
          finishBlocked({
            goalId,
            runId: run.id,
            reason: decision.reason,
            goalRepo,
            runRepo,
            eventRepo,
          });
          return;
        }

        if (decision.decision !== "IMPLEMENT_DIRECTLY") {
          throw new Error(`Unsupported loop decision for this step: ${decision.decision}`);
        }

        const step = stepRepo.create({
          goalId,
          runId: run.id,
          title: decision.nextStep,
          description: decision.reason,
          order,
        });

        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "step.started",
          message: `Step started: ${step.title}`,
          data: { stepId: step.id },
        });

        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "agent.decision",
          message: `Planner decision: ${decision.decision}`,
          data: plannerDecisionData(decision),
        });

        const implementation = await implementer.implement({ goal, step: decision.nextStep });
        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "agent.message",
          message: implementation.result,
          data: {
            stepId: step.id,
            role: "implementer",
            step: implementation.step,
          },
        });

        const vote = await gate.vote({ goal, step, implementation });
        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "gate.voted",
          message: `Gate voted: ${vote.decision}`,
          data: buildGateVotedEventData(vote),
        });

        stepRepo.update(step.id, { status: "completed", result: implementation.result });
        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "step.completed",
          message: `Step completed: ${step.title}`,
          data: { stepId: step.id },
        });

        if (vote.isDone) {
          finishCompleted({ goalId, runId: run.id, metadata, goalRepo, runRepo, eventRepo });
          return;
        }
      }

      finishBounded({
        goalId,
        runId: run.id,
        bound: "maxSteps",
        value: maxSteps,
        goalRepo,
        runRepo,
        eventRepo,
      });
    },
  };
}

function plannerDecisionData(result: PlannerResult) {
  return { ...result };
}

interface FinishInput {
  goalId: string;
  runId: string;
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  eventRepo: EventRepository;
}

interface FinishCompletedInput extends FinishInput {
  metadata: ModelProviderMetadata;
}

function finishCompleted({
  goalId,
  runId,
  metadata,
  goalRepo,
  runRepo,
  eventRepo,
}: FinishCompletedInput): void {
  const finishedAt = new Date().toISOString();
  runRepo.updateStatus(runId, "completed", { finishedAt });
  goalRepo.updateStatus(goalId, "completed", { completedAt: finishedAt });

  eventRepo.create({
    goalId,
    runId,
    type: "run.completed",
    message: "Agent loop run completed",
    data: { runId, provider: metadata.provider, model: metadata.model },
  });

  eventRepo.create({
    goalId,
    runId,
    type: "goal.completed",
    message: "Goal completed successfully",
    data: { goalId, runId, provider: metadata.provider, model: metadata.model },
  });
}

interface FinishBoundedInput extends FinishInput {
  bound: "maxSteps" | "maxDepth";
  value: number;
}

function finishBounded(input: FinishBoundedInput): void {
  const finishedAt = new Date().toISOString();
  input.runRepo.updateStatus(input.runId, "completed", { finishedAt });
  input.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: finishedAt });

  input.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "run.completed",
    message: `Agent loop stopped at ${input.bound}`,
    data: { runId: input.runId, terminalState: "bounded", bound: input.bound },
  });

  input.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "goal.blocked",
    message: `Goal stopped at ${input.bound}`,
    data: {
      goalId: input.goalId,
      runId: input.runId,
      terminalState: "bounded",
      bound: input.bound,
      [input.bound]: input.value,
    },
  });
}

interface FinishBlockedInput extends FinishInput {
  reason: string;
}

function finishBlocked(input: FinishBlockedInput): void {
  const finishedAt = new Date().toISOString();
  input.runRepo.updateStatus(input.runId, "completed", { finishedAt });
  input.goalRepo.updateStatus(input.goalId, "blocked", { completedAt: finishedAt });

  input.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "run.completed",
    message: "Agent loop blocked",
    data: { runId: input.runId, terminalState: "blocked" },
  });

  input.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "goal.blocked",
    message: input.reason,
    data: {
      goalId: input.goalId,
      runId: input.runId,
      terminalState: "blocked",
      reason: input.reason,
    },
  });
}
