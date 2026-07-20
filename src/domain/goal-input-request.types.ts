import type { ReassessmentGap } from "./agent-runtime-control-plane.types.js";

/**
 * Goal-level escalation contract: when a recoverable budget bound would
 * terminally block a goal, the backend records a structured input request and
 * waits in `waiting_user` for the goal's caller — a human dashboard or an
 * agent client — to answer. Requests and responses are machine-readable and
 * deterministically validated; prose is never enforcement.
 */
export type GoalInputRequestReason =
  | "epoch_budget_exhausted"
  | "reassessment_circuit_breaker"
  | "continuation_exhausted"
  | "supervisor_question";

export type GoalInputDecision = "extend_budget" | "provide_guidance" | "abandon";

/** The bound whose exhaustion (or governing loop) triggered the escalation. */
export type GoalInputBudgetName = "planning_epochs" | "supervisor_continuations";

export interface GoalInputRequestPayload {
  /** Null for supervisor questions — a question exhausts no budget. */
  budgetName: GoalInputBudgetName | null;
  /** Effective value of the bound at escalation time (base + accepted grants). */
  budgetValue: number | null;
  evidence: string[];
  remainingGaps: ReassessmentGap[];
  allowedDecisions: GoalInputDecision[];
}

export type GoalInputResponse =
  | { decision: "extend_budget"; extension: number }
  | { decision: "provide_guidance"; guidance: string }
  | { decision: "abandon"; reason: string | null };

export type GoalInputRequestStatus = "pending" | "accepted" | "abandoned" | "cancelled";

export interface GoalInputRequest {
  id: string;
  goalId: string;
  reasonCode: GoalInputRequestReason;
  safeSummary: string;
  payload: GoalInputRequestPayload;
  status: GoalInputRequestStatus;
  response: GoalInputResponse | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Allowed decisions are fixed per reason: extending budget without new
 * information would repeat the loop the circuit breaker just caught, and a
 * supervisor question has no budget to extend. */
export function allowedDecisionsForReason(reason: GoalInputRequestReason): GoalInputDecision[] {
  return reason === "reassessment_circuit_breaker" || reason === "supervisor_question"
    ? ["provide_guidance", "abandon"]
    : ["extend_budget", "provide_guidance", "abandon"];
}

/** Reasons whose accepted guidance implies the minimal +1 budget grant. */
export const budgetGrantReasons: readonly GoalInputRequestReason[] = [
  "epoch_budget_exhausted",
  "continuation_exhausted",
];
