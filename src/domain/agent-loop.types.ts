export const plannerDecisionValues = [
  "IMPLEMENT_DIRECTLY",
  "DECOMPOSE",
  "NEEDS_OPENSPEC",
  "BLOCKED",
] as const;

export type PlannerDecision = (typeof plannerDecisionValues)[number];

export interface ImplementDirectlyPlannerResult {
  decision: "IMPLEMENT_DIRECTLY";
  scopeAssessment?: PlannerScopeAssessment;
  nextStep: string;
  reason: string;
}

export interface DecomposePlannerResult {
  decision: "DECOMPOSE";
  scopeAssessment?: PlannerScopeAssessment;
  subSteps: string[];
  reason: string;
}

export interface NeedsOpenSpecPlannerResult {
  decision: "NEEDS_OPENSPEC";
  reason: string;
}

export interface BlockedPlannerResult {
  decision: "BLOCKED";
  reason: string;
  rawOutput?: string;
}

export type PlannerResult =
  | ImplementDirectlyPlannerResult
  | DecomposePlannerResult
  | NeedsOpenSpecPlannerResult
  | BlockedPlannerResult;

export interface ImplementerResult {
  step: string;
  result: string;
}

export type PlannerScopeAssessment = "ready" | "too_large" | "too_small";

export type ScopeVoteDecision = boolean;

export interface ScopeVoterBallot {
  voterId: string;
  providerKind: string;
  persona?: string;
  decision: ScopeVoteDecision;
  reason: string;
  rawOutput?: string;
  error?: string;
}

export interface ScopeVoteTally {
  refine: number;
  proceed: number;
  total: number;
  majorityReached: boolean;
}

export interface ScopeVoteResult {
  proposition: string;
  ballots: ScopeVoterBallot[];
  tally: ScopeVoteTally;
  shouldRefine: boolean;
  decision: ScopeVoteDecision;
}

export type QuorumVoteDecision = "done" | "not_done" | "abstain";

export type QuorumGateDecision = "done" | "not_done";

export interface QuorumVoterBallot {
  voterId: string;
  providerKind: string;
  persona?: string;
  decision: QuorumVoteDecision;
  reason: string;
  rawOutput?: string;
  error?: string;
}

export interface QuorumVoteTally {
  done: number;
  notDone: number;
  abstain: number;
  total: number;
  majorityReached: boolean;
}

export interface QuorumVoteResult {
  proposition: string;
  ballots: QuorumVoterBallot[];
  tally: QuorumVoteTally;
  isDone: boolean;
  decision: QuorumGateDecision;
}
