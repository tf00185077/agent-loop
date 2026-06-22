import type { Goal, PlannerResult, PlannerScopeAssessment, Step } from "../domain/index.js";
import type { ModelProvider } from "./model-provider.js";

export interface PlannerPromptInput {
  goal: Goal;
  priorSteps: Step[];
  scopeRefinementContext?: PlannerScopeRefinementContext;
}

export interface PlannerPlanInput extends PlannerPromptInput {}

export interface PlannerScopeRefinementContext {
  assessmentAttempt: number;
  refinementRound: number;
  previousPlannerReason?: string;
  previousVoterReason?: string;
}

export interface Planner {
  plan(input: PlannerPlanInput): Promise<PlannerResult>;
}

export interface PlannerDeps {
  provider: ModelProvider;
}

export function createPlanner({ provider }: PlannerDeps): Planner {
  return {
    async plan(input) {
      const output = await provider.complete({
        goal: {
          id: input.goal.id,
          title: input.goal.title,
          description: input.goal.description,
        },
        prompt: buildPlannerPrompt(input),
      });

      return parsePlannerOutput(output.text);
    },
  };
}

export function buildPlannerPrompt({
  goal,
  priorSteps,
  scopeRefinementContext,
}: PlannerPromptInput): string {
  const stepHistory =
    priorSteps.length === 0
      ? "No prior steps have been persisted for this run."
      : priorSteps
          .map((step) =>
            [
              `${step.order}. ${step.title}`,
              `Description: ${step.description}`,
              `Status: ${step.status}`,
              `Result: ${step.result ?? "(none)"}`,
            ].join("\n"),
      )
          .join("\n\n");
  const refinementContext = scopeRefinementContext
    ? [
        "Scope refinement context:",
        `Assessment attempt: ${scopeRefinementContext.assessmentAttempt}`,
        `Refinement round: ${scopeRefinementContext.refinementRound}`,
        `Previous planner reason: ${scopeRefinementContext.previousPlannerReason ?? "(none)"}`,
        `Previous voter reason: ${scopeRefinementContext.previousVoterReason ?? "(none)"}`,
      ].join("\n")
    : "No scope refinement context is active.";

  return [
    "You are the planner for a bounded iterative agent loop.",
    "Choose exactly one next action using this strict output convention:",
    "DECISION: IMPLEMENT_DIRECTLY|DECOMPOSE|NEEDS_OPENSPEC|BLOCKED",
    "SCOPE: ready|too_large|too_small",
    "NEXT_STEP: <required for IMPLEMENT_DIRECTLY>",
    "SUB_STEPS: <one sub-step per line, prefixed with -; required for DECOMPOSE>",
    "REASON: <brief reason>",
    "",
    "Goal:",
    `Title: ${goal.title}`,
    `Description: ${goal.description}`,
    "",
    "Persisted prior steps:",
    stepHistory,
    "",
    refinementContext,
  ].join("\n");
}

export function parsePlannerOutput(output: string): PlannerResult {
  try {
    return parseStrictPlannerOutput(output);
  } catch (err) {
    return {
      decision: "BLOCKED",
      reason: `Planner output could not be parsed: ${errorMessage(err)}`,
      rawOutput: output,
    };
  }
}

function parseStrictPlannerOutput(output: string): PlannerResult {
  const decision = lineValue(output, "DECISION");
  const reason = lineValue(output, "REASON");

  if (decision === "IMPLEMENT_DIRECTLY") {
    return {
      decision,
      ...scopeAssessmentData(output),
      nextStep: lineValue(output, "NEXT_STEP"),
      reason,
    };
  }

  if (decision === "DECOMPOSE") {
    return {
      decision,
      ...scopeAssessmentData(output),
      subSteps: parseSubSteps(output),
      reason,
    };
  }

  if (decision === "NEEDS_OPENSPEC") {
    return { decision, reason };
  }

  if (decision === "BLOCKED") {
    return { decision, reason };
  }

  throw new Error(`Unsupported planner decision: ${decision}`);
}

function scopeAssessmentData(output: string): { scopeAssessment?: PlannerScopeAssessment } {
  const value = optionalLineValue(output, "SCOPE");
  if (value === undefined) return {};
  if (value === "ready" || value === "too_large" || value === "too_small") {
    return { scopeAssessment: value };
  }
  throw new Error(`Unsupported planner scope assessment: ${value}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lineValue(output: string, label: string): string {
  const prefix = `${label}:`;
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith(prefix));
  if (!line) throw new Error(`Missing planner output line: ${prefix}`);
  const value = line.trim().slice(prefix.length).trim();
  if (!value) throw new Error(`Empty planner output line: ${prefix}`);
  return value;
}

function optionalLineValue(output: string, label: string): string | undefined {
  const prefix = `${label}:`;
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith(prefix));
  if (!line) return undefined;
  const value = line.trim().slice(prefix.length).trim();
  if (!value) throw new Error(`Empty planner output line: ${prefix}`);
  return value;
}

function parseSubSteps(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().startsWith("SUB_STEPS:"));
  if (startIndex === -1) throw new Error("Missing planner output line: SUB_STEPS:");

  const subSteps: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("REASON:")) break;
    if (trimmed.startsWith("-")) {
      const subStep = trimmed.slice(1).trim();
      if (subStep) subSteps.push(subStep);
    }
  }
  if (subSteps.length === 0) throw new Error("Planner DECOMPOSE output requires sub-steps");
  return subSteps;
}
