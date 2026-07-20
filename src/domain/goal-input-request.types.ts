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
  | "supervisor_question"
  | "plan_confirmation";

export type GoalInputDecision = "extend_budget" | "provide_guidance" | "proceed" | "abandon";

/** The bound whose exhaustion (or governing loop) triggered the escalation. */
export type GoalInputBudgetName = "planning_epochs" | "supervisor_continuations";

/** Reasons that open a multi-turn conversation rather than a single-turn request. */
export const conversationReasons: readonly GoalInputRequestReason[] = [
  "supervisor_question",
  "plan_confirmation",
];

export function isConversationReason(reason: GoalInputRequestReason): boolean {
  return conversationReasons.includes(reason);
}

export type GoalInputMessageRole = "supervisor" | "caller";

export interface GoalInputMessage {
  role: GoalInputMessageRole;
  text: string;
  at: string;
}

/** Whose turn it is in an open conversation, or `resolved` once closed. */
export type GoalInputPhase = "awaiting_caller" | "awaiting_supervisor" | "resolved";

export interface GoalInputRequestPayload {
  /** Null for conversation reasons — a question/proposal exhausts no budget. */
  budgetName: GoalInputBudgetName | null;
  /** Effective value of the bound at escalation time (base + accepted grants). */
  budgetValue: number | null;
  evidence: string[];
  remainingGaps: ReassessmentGap[];
  allowedDecisions: GoalInputDecision[];
  /** Present for conversation reasons: the durable back-and-forth so far. */
  thread?: GoalInputMessage[];
  /** Present for conversation reasons: whose turn it is. */
  phase?: GoalInputPhase;
}

export type GoalInputResponse =
  | { decision: "extend_budget"; extension: number }
  | { decision: "provide_guidance"; guidance: string }
  | { decision: "proceed"; note: string | null }
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
 * information would repeat the loop the circuit breaker just caught; a
 * conversation has no budget to extend but the caller may force `proceed`. */
export function allowedDecisionsForReason(reason: GoalInputRequestReason): GoalInputDecision[] {
  if (isConversationReason(reason)) {
    return ["provide_guidance", "proceed", "abandon"];
  }
  return reason === "reassessment_circuit_breaker"
    ? ["provide_guidance", "abandon"]
    : ["extend_budget", "provide_guidance", "abandon"];
}

/** Reasons whose accepted guidance implies the minimal +1 budget grant. */
export const budgetGrantReasons: readonly GoalInputRequestReason[] = [
  "epoch_budget_exhausted",
  "continuation_exhausted",
];
