import type { AgentSessionLifecycleState, GoalStatus } from "../../domain/index.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type {
  AgentSessionRepository,
  EventRepository,
} from "../../persistence/runtime-repositories.js";
import { sanitizeControlPlaneText } from "../safety/agent-runtime-control-plane-sanitizer.js";

/**
 * Outermost durable safety net for the runtime's fire-and-forget async
 * boundaries. It records an otherwise-unhandled failure as a durable event and
 * a durable status transition, so a background rejection can never leave a goal
 * silently stuck. It is deliberately idempotent (never overwrites an
 * already-terminal state) and must never throw — it is the last line of defense
 * and cannot be allowed to create a second unhandled rejection.
 *
 * This helper only makes failure visible. It does not recover, retry, or resume.
 */
export interface UnhandledFailureDeps {
  /** Required for `goal`-scoped failures; the delegation boundary omits it. */
  goalRepo?: Pick<GoalRepository, "getById" | "updateStatus">;
  eventRepo: Pick<EventRepository, "create">;
  agentSessionRepo?: Pick<AgentSessionRepository, "getSession" | "updateLifecycleState">;
}

export type UnhandledFailureInput =
  | { kind: "goal"; goalId: string; error: unknown }
  | {
      kind: "delegation";
      goalId: string;
      runId: string | null;
      delegationRequestId: string;
      childSessionId: string;
      error: unknown;
    };

const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

const TERMINAL_SESSION_STATES: ReadonlySet<AgentSessionLifecycleState> =
  new Set<AgentSessionLifecycleState>(["completed", "failed", "cancelled"]);

export function recordUnhandledRuntimeFailure(
  deps: UnhandledFailureDeps,
  input: UnhandledFailureInput,
): void {
  try {
    if (input.kind === "goal") {
      recordGoalFailure(deps, input.goalId, input.error);
    } else {
      recordDelegationFailure(deps, input);
    }
  } catch {
    // The safety net must never throw; swallowing here prevents a second
    // unhandled rejection. The original failure is already the observable event
    // we were trying to record, and losing the net-of-the-net is acceptable.
  }
}

function recordGoalFailure(deps: UnhandledFailureDeps, goalId: string, error: unknown): void {
  if (!deps.goalRepo) return;
  const goal = deps.goalRepo.getById(goalId);
  if (!goal || TERMINAL_GOAL_STATUSES.has(goal.status)) return;

  deps.eventRepo.create({
    goalId,
    type: "error",
    message: "Background supervisor run failed without a durable trace.",
    data: {
      runtimeEventType: "runtime.unhandled_failure",
      scope: "goal",
      safeReason: safeReason(error),
    },
  });
  deps.goalRepo.updateStatus(goalId, "failed", { completedAt: new Date().toISOString() });
}

function recordDelegationFailure(
  deps: UnhandledFailureDeps,
  input: Extract<UnhandledFailureInput, { kind: "delegation" }>,
): void {
  deps.eventRepo.create({
    goalId: input.goalId,
    runId: input.runId,
    type: "error",
    message: "Child event consumption failed without a durable trace.",
    data: {
      runtimeEventType: "runtime.unhandled_failure",
      scope: "delegation",
      delegationRequestId: input.delegationRequestId,
      childSessionId: input.childSessionId,
      safeReason: safeReason(input.error),
    },
  });

  const session = deps.agentSessionRepo?.getSession(input.childSessionId);
  if (session && !TERMINAL_SESSION_STATES.has(session.lifecycleState)) {
    deps.agentSessionRepo!.updateLifecycleState(input.childSessionId, "failed");
  }
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeControlPlaneText(raw).slice(0, 500);
}
