import {
  createAgentObservationEventInput,
  type AgentObservation,
  type Goal,
} from "../../domain/index.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type {
  EventRepository,
  RunRepository,
  StepRepository,
} from "../../persistence/runtime-repositories.js";
import type { ModelProvider, ModelProviderInput, ModelProviderOutput } from "./model-provider.js";
import { sanitizeAgentObservation } from "../safety/agent-observation-sanitizer.js";
import { sanitizeProcessOutput } from "../safety/process-output-sanitizer.js";

export interface ProviderRuntimeDeps {
  goalRepo: GoalRepository;
  runRepo: RunRepository;
  stepRepo: StepRepository;
  eventRepo: EventRepository;
  provider: ModelProvider;
  heartbeatIntervalMs?: number;
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

      const initialMetadata = provider.metadata ?? { provider: "unknown", model: "unknown" };
      const run = runRepo.create({
        goalId,
        provider: initialMetadata.provider,
        model: initialMetadata.model,
      });
      let observationsSeen = false;

      const heartbeatTimer =
        deps.heartbeatIntervalMs && deps.heartbeatIntervalMs > 0
          ? setInterval(() => {
              const heartbeat = sanitizeAgentObservation({
                kind: "heartbeat",
                message: "Provider is still running",
                metadata: {
                  provider: provider.metadata?.provider ?? initialMetadata.provider,
                  model: provider.metadata?.model ?? initialMetadata.model,
                  source: "runtime",
                  rawEventType: "provider.heartbeat",
                },
              });
              observationsSeen = true;
              eventRepo.create(
                createAgentObservationEventInput({
                  goalId,
                  runId: run.id,
                  observation: heartbeat,
                }),
              );
            }, deps.heartbeatIntervalMs)
          : null;

      const input = {
        goal: toProviderGoalContext(goal),
        prompt: buildProviderPrompt(goal),
        conversationState: options?.conversationState,
        continuation: selectContinuation(provider, options?.conversationState),
        onProgress: (progress: string | AgentObservation) => {
          if (typeof progress === "string") {
            const sanitized = sanitizeProcessOutput(progress).trim();
            if (!sanitized) return;
            eventRepo.create({
              goalId,
              runId: run.id,
              type: "agent.progress",
              message: sanitized,
              data: { provider: provider.metadata?.provider ?? "unknown" },
            });
            observationsSeen = true;
            return;
          }

          const sanitized = sanitizeAgentObservation({
            ...progress,
            metadata: {
              provider: provider.metadata?.provider ?? progress.metadata?.provider,
              model: provider.metadata?.model ?? progress.metadata?.model,
              ...progress.metadata,
            },
          });
          if (!sanitized.message) return;
          eventRepo.create(
            createAgentObservationEventInput({
              goalId,
              runId: run.id,
              observation: sanitized,
            }),
          );
          observationsSeen = true;
        },
      };
      let output: ModelProviderOutput;
      try {
        output = await provider.complete(input);
      } catch (err) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const message = errorMessage(err);
        const metadata = provider.metadata ?? initialMetadata;
        const finishedAt = new Date().toISOString();
        runRepo.updateStatus(run.id, "failed", { finishedAt, error: message });
        goalRepo.updateStatus(goalId, "failed", { completedAt: finishedAt });
        const timeout = isTimeoutError(message);
        if (timeout && !observationsSeen) {
          eventRepo.create({
            goalId,
            runId: run.id,
            type: "agent.progress",
            message: "No provider progress was observed before timeout",
            data: {
              provider: metadata.provider,
              model: metadata.model,
              source: "runtime",
              timeout: true,
            },
          });
        }
        eventRepo.create({
          goalId,
          runId: run.id,
          type: "error",
          message,
          data: {
            runId: run.id,
            provider: metadata.provider,
            model: metadata.model,
            ...(timeout ? { timeout: true, observedProgress: observationsSeen } : {}),
          },
        });
        return undefined;
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      runRepo.updateMetadata(run.id, output.metadata);

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

function selectContinuation(
  provider: ModelProvider,
  conversationState: unknown,
): ModelProviderInput["continuation"] {
  if (conversationState === undefined) return undefined;
  if (provider.capabilities?.trueResume) {
    return { mode: "resume" };
  }
  return {
    mode: "fresh",
    reason: provider.capabilities?.continuationFallback
      ? "Provider true resume is unavailable; using fresh continuation."
      : "Provider capabilities do not advertise true resume.",
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

function isTimeoutError(message: string): boolean {
  return /\btimed out\b|\btimeout\b/i.test(message);
}
