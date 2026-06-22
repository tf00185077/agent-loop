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
  planner: Planner;
  implementer: Implementer;
  gate: CompletionGate;
}

export interface AgentLoopRuntime {
  run(goalId: string): Promise<void>;
}

export function createAgentLoopRuntime(deps: AgentLoopRuntimeDeps): AgentLoopRuntime {
  const { goalRepo, runRepo, stepRepo, eventRepo, metadata, planner, implementer, gate } = deps;

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
        message: "Agent loop run started",
        data: {
          runId: run.id,
          provider: metadata.provider,
          model: metadata.model,
        },
      });

      const priorSteps = stepRepo.listForRun(run.id);
      const decision = await planner.plan({ goal, priorSteps });
      if (decision.decision !== "IMPLEMENT_DIRECTLY") {
        throw new Error(`Unsupported loop decision for this step: ${decision.decision}`);
      }

      const step = stepRepo.create({
        goalId,
        runId: run.id,
        title: decision.nextStep,
        description: decision.reason,
        order: 1,
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
        const finishedAt = new Date().toISOString();
        runRepo.updateStatus(run.id, "completed", { finishedAt });
        goalRepo.updateStatus(goalId, "completed", { completedAt: finishedAt });

        eventRepo.create({
          goalId,
          runId: run.id,
          type: "run.completed",
          message: "Agent loop run completed",
          data: { runId: run.id },
        });

        eventRepo.create({
          goalId,
          runId: run.id,
          type: "goal.completed",
          message: "Goal completed successfully",
          data: { goalId, runId: run.id },
        });
      }
    },
  };
}

function plannerDecisionData(result: PlannerResult) {
  return { ...result };
}
