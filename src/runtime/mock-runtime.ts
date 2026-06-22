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
  maxSteps?: number;
  maxDepth?: number;
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
    maxSteps: deps.maxSteps ?? 2,
    maxDepth: deps.maxDepth ?? 1,
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
        const ballots = isDone
          ? [
              {
                voterId: "mock-voter-1",
                providerKind: "mock",
                decision: "done" as const,
                reason: "The fixed mock plan reached its final step.",
              },
              {
                voterId: "mock-voter-2",
                providerKind: "mock",
                decision: "done" as const,
                reason: "The final mock implementation result satisfies the goal.",
              },
              {
                voterId: "mock-voter-3",
                providerKind: "mock",
                decision: "not_done" as const,
                reason: "A conservative mock voter asks for one more pass.",
              },
            ]
          : [
              {
                voterId: "mock-voter-1",
                providerKind: "mock",
                decision: "not_done" as const,
                reason: "The deterministic mock loop still has one step remaining.",
              },
              {
                voterId: "mock-voter-2",
                providerKind: "mock",
                decision: "done" as const,
                reason: "The first mock implementation result is acceptable but not terminal.",
              },
              {
                voterId: "mock-voter-3",
                providerKind: "mock",
                decision: "not_done" as const,
                reason: "Continue until the fixed mock plan reaches its final step.",
              },
            ];
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
          ballots,
        };
      },
    },
  });
}
