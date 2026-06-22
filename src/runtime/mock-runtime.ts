import type { GoalRepository } from "../persistence/goal-repository.js";
import type {
  EventRepository,
  RunRepository,
  StepRepository,
} from "../persistence/runtime-repositories.js";
import { createAgentLoopRuntime } from "./agent-loop-runtime.js";

export interface MockRuntimeDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  stepRepo: StepRepository;
  eventRepo: EventRepository;
}

export interface MockRuntime {
  run(goalId: string): Promise<void>;
}

const MOCK_METADATA = { provider: "mock", model: "mock-v1" };

function shouldBlock(title: string): boolean {
  return title.trim().toLowerCase().startsWith("block");
}

export function createMockRuntime(deps: MockRuntimeDeps): MockRuntime {
  return createAgentLoopRuntime({
    ...deps,
    metadata: MOCK_METADATA,
    maxSteps: 2,
    maxDepth: 1,
    runStartedMessage: "Mock run started",
    planner: {
      async plan(input) {
        if (shouldBlock(input.goal.title)) {
          return {
            decision: "BLOCKED",
            reason: "Goal blocked by mock runtime",
          };
        }

        return {
          decision: "IMPLEMENT_DIRECTLY",
          nextStep: input.priorSteps.length === 0 ? "Analyze goal" : "Execute mock result",
          reason: "Deterministic mock loop step",
        };
      },
    },
    implementer: {
      async implement(input) {
        return {
          step: input.step,
          result: `Completed: ${input.step}`,
        };
      },
    },
    gate: {
      async vote(input) {
        const isDone = input.implementation.step === "Execute mock result";
        return {
          proposition: "Does the current result satisfy the goal?",
          decision: isDone ? "done" : "not_done",
          isDone,
          tally: {
            done: isDone ? 2 : 1,
            notDone: isDone ? 1 : 2,
            abstain: 0,
            total: 3,
            majorityReached: isDone,
          },
          ballots: [],
        };
      },
    },
  });
}
