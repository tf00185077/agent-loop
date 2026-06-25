import type { Goal } from "../../domain/index.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type {
  EventRepository,
  RunRepository,
  StepRepository,
} from "../../persistence/runtime-repositories.js";
import type { ModelProvider, ModelProviderOutput } from "./model-provider.js";
import { sanitizeProcessOutput } from "../safety/process-output-sanitizer.js";

export interface ProviderRuntimeDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  stepRepo: StepRepository;
  eventRepo: EventRepository;
  provider: ModelProvider;
}

export interface ProviderRunOptions {
  /**
   * Opaque continuation token previously returned by the same provider. The
   * runtime forwards it to the provider unchanged and never interprets it.
   */
  conversationState?: unknown;
}

export interface ProviderRuntime {
  run(goalId: string, options?: ProviderRunOptions): Promise<ModelProviderOutput | undefined>;
}

export function createProviderRuntime(deps: ProviderRuntimeDeps): ProviderRuntime {
  const { goalRepo, runRepo, stepRepo, eventRepo, provider } = deps;

  return {
    async run(goalId, options) {
      const goal = goalRepo.getById(goalId);
      if (!goal) throw new Error(`Goal not found: ${goalId}`);

      const input = {
        goal: toProviderGoalContext(goal),
        prompt: buildProviderPrompt(goal),
        conversationState: options?.conversationState,
        onProgress: (chunk: string) => {
          const sanitized = sanitizeProcessOutput(chunk).trim();
          if (!sanitized) return;
          eventRepo.create({
            goalId,
            type: "agent.progress",
            message: sanitized,
            data: { provider: provider.metadata?.provider ?? "unknown" },
          });
        },
      };
      let output: ModelProviderOutput;
      try {
        output = await provider.complete(input);
      } catch (err) {
        const message = errorMessage(err);
        const metadata = provider.metadata ?? { provider: "unknown", model: "unknown" };
        const run = runRepo.create({
          goalId,
          provider: metadata.provider,
          model: metadata.model,
        });
        const finishedAt = new Date().toISOString();
        runRepo.updateStatus(run.id, "failed", { finishedAt, error: message });
        goalRepo.updateStatus(goalId, "failed", { completedAt: finishedAt });
        eventRepo.create({
          goalId,
          runId: run.id,
          type: "error",
          message,
          data: { runId: run.id, provider: metadata.provider, model: metadata.model },
        });
        return undefined;
      }
      const run = runRepo.create({
        goalId,
        provider: output.metadata.provider,
        model: output.metadata.model,
      });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "run.started",
        message: "Provider run started",
        data: {
          runId: run.id,
          provider: output.metadata.provider,
          model: output.metadata.model,
        },
      });

      const step = stepRepo.create({
        goalId,
        runId: run.id,
        title: "Provider smoke step",
        description: "Call the configured model provider once",
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
        type: "agent.message",
        message: output.text,
        data: {
          stepId: step.id,
          provider: output.metadata.provider,
          model: output.metadata.model,
        },
      });

      stepRepo.update(step.id, { status: "completed", result: output.text });

      eventRepo.create({
        goalId,
        runId: run.id,
        stepId: step.id,
        type: "step.completed",
        message: `Step completed: ${step.title}`,
        data: { stepId: step.id },
      });

      const finishedAt = new Date().toISOString();
      runRepo.updateStatus(run.id, "completed", { finishedAt });
      goalRepo.updateStatus(goalId, "completed", { completedAt: finishedAt });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "run.completed",
        message: "Provider run completed successfully",
        data: { runId: run.id },
      });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "goal.completed",
        message: "Goal completed successfully",
        data: { goalId, runId: run.id },
      });

      return output;
    },
  };
}

function toProviderGoalContext(goal: Goal) {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
  };
}

function buildProviderPrompt(goal: Goal): string {
  return `Complete this goal:\n\nTitle: ${goal.title}\nDescription: ${goal.description}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
