import type { Goal } from "../domain/index.js";
import type { GoalRepository } from "../persistence/goal-repository.js";
import type { ModelProvider, ModelProviderOutput } from "./model-provider.js";

export interface ProviderRuntimeDeps {
  goalRepo: GoalRepository;
  provider: ModelProvider;
}

export interface ProviderRuntime {
  run(goalId: string): Promise<ModelProviderOutput>;
}

export function createProviderRuntime(deps: ProviderRuntimeDeps): ProviderRuntime {
  const { goalRepo, provider } = deps;

  return {
    async run(goalId) {
      const goal = goalRepo.getById(goalId);
      if (!goal) throw new Error(`Goal not found: ${goalId}`);

      return provider.complete({
        goal: toProviderGoalContext(goal),
        prompt: buildProviderPrompt(goal),
      });
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
