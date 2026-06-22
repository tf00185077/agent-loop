export const plannerDecisionValues = [
  "IMPLEMENT_DIRECTLY",
  "DECOMPOSE",
  "NEEDS_OPENSPEC",
  "BLOCKED",
] as const;

export type PlannerDecision = (typeof plannerDecisionValues)[number];

export interface ImplementDirectlyPlannerResult {
  decision: "IMPLEMENT_DIRECTLY";
  nextStep: string;
  reason: string;
}

export interface DecomposePlannerResult {
  decision: "DECOMPOSE";
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

export type QuorumVoteDecision = "done" | "not_done" | "abstain";

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
}
