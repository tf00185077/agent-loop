import type { GoalRepository } from "../persistence/goal-repository.js";
import type {
  EventRepository,
  RunRepository,
  StepRepository,
} from "../persistence/runtime-repositories.js";

export interface MockRuntimeDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  stepRepo: StepRepository;
  eventRepo: EventRepository;
}

export interface MockRuntime {
  run(goalId: string): Promise<void>;
}

const MOCK_STEPS = [
  { title: "Analyze goal", description: "Parse and understand the goal context" },
  { title: "Plan approach", description: "Determine the best strategy" },
  { title: "Execute work", description: "Carry out the planned approach" },
];

const MOCK_METADATA = { provider: "mock", model: "mock-v1" };

// Deterministic block: goals whose title starts with "block" go to blocked state
function shouldBlock(title: string): boolean {
  return title.trim().toLowerCase().startsWith("block");
}

export function createMockRuntime(deps: MockRuntimeDeps): MockRuntime {
  const { goalRepo, runRepo, stepRepo, eventRepo } = deps;

  return {
    async run(goalId) {
      const goal = goalRepo.getById(goalId);
      if (!goal) throw new Error(`Goal not found: ${goalId}`);

      // 4.2 Create run and record run.started
      const run = runRepo.create({
        goalId,
        provider: MOCK_METADATA.provider,
        model: MOCK_METADATA.model,
      });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "run.started",
        message: "Mock run started",
        data: { runId: run.id, ...MOCK_METADATA },
      });

      // 4.5 Blocked path — deterministic
      if (shouldBlock(goal.title)) {
        runRepo.updateStatus(run.id, "failed", {
          finishedAt: new Date().toISOString(),
          error: "Goal blocked by mock runtime",
        });
        goalRepo.updateStatus(goalId, "blocked");
        eventRepo.create({
          goalId,
          runId: run.id,
          type: "goal.blocked",
          message: "Goal could not proceed — blocked by mock runtime",
          data: { runId: run.id, ...MOCK_METADATA },
        });
        return;
      }

      // 4.3 Create and complete mock steps
      for (let i = 0; i < MOCK_STEPS.length; i++) {
        const def = MOCK_STEPS[i];
        const step = stepRepo.create({
          goalId,
          runId: run.id,
          title: def.title,
          description: def.description,
          order: i + 1,
        });

        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "step.started",
          message: `Step started: ${step.title}`,
          data: { stepId: step.id, title: step.title },
        });

        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "agent.message",
          message: `Working on: ${step.description}`,
          data: { stepId: step.id },
        });

        stepRepo.update(step.id, { status: "completed", result: `Completed: ${step.title}` });

        eventRepo.create({
          goalId,
          runId: run.id,
          stepId: step.id,
          type: "step.completed",
          message: `Step completed: ${step.title}`,
          data: { stepId: step.id, title: step.title },
        });
      }

      // 4.4 Happy path completion
      const finishedAt = new Date().toISOString();
      runRepo.updateStatus(run.id, "completed", { finishedAt });
      goalRepo.updateStatus(goalId, "completed", { completedAt: finishedAt });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "run.completed",
        message: "Mock run completed successfully",
        data: { runId: run.id, ...MOCK_METADATA },
      });

      eventRepo.create({
        goalId,
        runId: run.id,
        type: "goal.completed",
        message: "Goal completed successfully",
        data: { goalId, runId: run.id, ...MOCK_METADATA },
      });
    },
  };
}
