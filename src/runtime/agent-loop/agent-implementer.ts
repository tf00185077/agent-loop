import type { Goal, ImplementerResult } from "../../domain/index.js";
import type { ModelProvider } from "../providers/model-provider.js";

export interface ImplementerPromptInput {
  goal: Goal;
  step: string;
}

export interface ImplementerImplementInput extends ImplementerPromptInput {}

export interface Implementer {
  implement(input: ImplementerImplementInput): Promise<ImplementerResult>;
}

export interface ImplementerDeps {
  provider: ModelProvider;
}

export function createImplementer({ provider }: ImplementerDeps): Implementer {
  return {
    async implement(input) {
      const output = await provider.complete({
        goal: {
          id: input.goal.id,
          title: input.goal.title,
          description: input.goal.description,
        },
        prompt: buildImplementerPrompt(input),
      });

      return {
        step: input.step,
        result: output.text,
      };
    },
  };
}

export function buildImplementerPrompt({ goal, step }: ImplementerPromptInput): string {
  return [
    "You are the text-only implementer for an iterative agent loop.",
    "Produce a concise result describing what was done for the direct step.",
    "Do not modify files or run commands.",
    "",
    "Goal:",
    `Title: ${goal.title}`,
    `Description: ${goal.description}`,
    "",
    "Direct step:",
    step,
  ].join("\n");
}
