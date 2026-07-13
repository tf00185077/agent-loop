import type { GoalRepository } from "../../persistence/goal-repository.js";
import type {
  EventRepository,
  RunRepository,
  StepRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentLoopRuntime } from "../agent-loop/agent-loop-runtime.js";

export interface MockRuntimeDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  stepRepo: StepRepository;
  eventRepo: EventRepository;
  maxSteps?: number;
  maxDepth?: number;
  maxScopeAssessmentAttempts?: number;
  maxScopeRefinementRounds?: number;
}

export interface MockRuntime {
  run(goalId: string): Promise<void>;
}

const MOCK_METADATA = { provider: "mock", model: "mock-v1" };

function shouldBlock(title: string): boolean {
  return title.trim().toLowerCase().startsWith("block");
}

function shouldExerciseScopeVote(title: string): boolean {
  return title.trim().toLowerCase().startsWith("scope");
}

export function createMockRuntime(deps: MockRuntimeDeps): MockRuntime {
  return createAgentLoopRuntime({
    ...deps,
    metadata: MOCK_METADATA,
    maxSteps: deps.maxSteps ?? 2,
    maxDepth: deps.maxDepth ?? 1,
    maxScopeAssessmentAttempts: deps.maxScopeAssessmentAttempts ?? 3,
    maxScopeRefinementRounds: deps.maxScopeRefinementRounds ?? 3,
    runStartedMessage: "Mock run started",
    planner: {
      async plan(input) {
        if (shouldBlock(input.goal.title)) {
          return {
            decision: "BLOCKED",
            reason: "Goal blocked by mock runtime",
          };
        }
        if (shouldExerciseScopeVote(input.goal.title)) {
          return {
            decision: "DECOMPOSE",
            scopeAssessment: "too_large",
            subSteps: ["Proceed with the first mock sub-step"],
            reason: "Mock goal intentionally exercises scope voting.",
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
    scopeGate: {
      async vote() {
        const ballots = [
          {
            voterId: "mock-voter-1",
            providerKind: "mock",
            decision: false,
            reason: "The mock scope is acceptable for one implementer.",
          },
          {
            voterId: "mock-voter-2",
            providerKind: "mock",
            decision: false,
            reason: "Proceed with the first mock sub-step.",
          },
          {
            voterId: "mock-voter-3",
            providerKind: "mock",
            decision: true,
            reason: "A conservative mock voter requests one more split.",
          },
        ];
        return {
          proposition: "Is the current task still too large?",
          decision: false,
          shouldRefine: false,
          tally: {
            refine: 1,
            proceed: 2,
            total: 3,
            majorityReached: false,
          },
          ballots,
        };
      },
    },
    gate: {
      async vote(input) {
        const isDone =
          input.implementation.step === "Execute mock result" ||
          input.implementation.step === "Proceed with the first mock sub-step";
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
