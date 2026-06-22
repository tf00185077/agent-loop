import type {
  EventData,
  QuorumVoteDecision,
  QuorumVoteResult,
  QuorumVoterBallot,
  ScopeVoteDecision,
  ScopeVoteResult,
  ScopeVoterBallot,
} from "../domain/index.js";

export type QuorumProviderKind = "codex-local" | "claude-local" | "openai-compatible";

export type QuorumVoterPersona = "skeptic" | "optimist";

export interface QuorumVoter {
  voterId: string;
  providerKind: QuorumProviderKind;
  persona?: QuorumVoterPersona;
}

export interface ResolveQuorumVotersInput {
  availableProviders: QuorumProviderKind[];
  fallbackProvider: QuorumProviderKind;
}

export interface RunQuorumVoteInput {
  proposition: string;
  voters: QuorumVoter[];
  vote: (voter: QuorumVoter, proposition: string) => Promise<QuorumVoterResponse>;
}

export interface RunScopeVoteInput {
  proposition: string;
  voters: QuorumVoter[];
  vote: (voter: QuorumVoter, proposition: string) => Promise<ScopeVoterResponse>;
}

export interface QuorumVoterResponse {
  decision: QuorumVoteDecision;
  reason: string;
  rawOutput?: string;
}

export interface ScopeVoterResponse {
  decision: ScopeVoteDecision;
  reason: string;
  rawOutput?: string;
}

const providerPriority: QuorumProviderKind[] = [
  "codex-local",
  "claude-local",
  "openai-compatible",
];

const fallbackPersonas: QuorumVoterPersona[] = ["skeptic", "optimist"];

export function resolveQuorumVoters(input: ResolveQuorumVotersInput): QuorumVoter[] {
  const available = new Set(input.availableProviders);
  const voters: QuorumVoter[] = providerPriority
    .filter((providerKind) => available.has(providerKind))
    .map((providerKind) => ({
      voterId: providerKind,
      providerKind,
    }));

  for (const persona of fallbackPersonas) {
    if (voters.length >= 3) break;
    voters.push({
      voterId: `${input.fallbackProvider}-${persona}`,
      providerKind: input.fallbackProvider,
      persona,
    });
  }

  return voters.slice(0, 3);
}

export async function runQuorumVote(input: RunQuorumVoteInput): Promise<QuorumVoteResult> {
  const ballots = await Promise.all(
    input.voters.map(async (voter) => {
      try {
        const response = await input.vote(voter, input.proposition);
        return toBallot(voter, response);
      } catch (err) {
        const message = errorMessage(err);
        const ballot: QuorumVoterBallot = {
          voterId: voter.voterId,
          providerKind: voter.providerKind,
          decision: "abstain",
          reason: `Voter failed: ${message}`,
          error: message,
        };
        if (voter.persona) ballot.persona = voter.persona;
        return ballot;
      }
    }),
  );

  const tally = {
    done: ballots.filter((ballot) => ballot.decision === "done").length,
    notDone: ballots.filter((ballot) => ballot.decision === "not_done").length,
    abstain: ballots.filter((ballot) => ballot.decision === "abstain").length,
    total: ballots.length,
    majorityReached: false,
  };
  tally.majorityReached = tally.done >= 2;
  const decision = tally.majorityReached ? "done" : "not_done";

  return {
    proposition: input.proposition,
    ballots,
    tally,
    isDone: tally.majorityReached,
    decision,
  };
}

export async function runScopeVote(input: RunScopeVoteInput): Promise<ScopeVoteResult> {
  const ballots = await Promise.all(
    input.voters.map(async (voter) => {
      try {
        const response = await input.vote(voter, input.proposition);
        return toScopeBallot(voter, response);
      } catch (err) {
        const message = errorMessage(err);
        const ballot: ScopeVoterBallot = {
          voterId: voter.voterId,
          providerKind: voter.providerKind,
          decision: false,
          reason: `Voter failed: ${message}`,
          error: message,
        };
        if (voter.persona) ballot.persona = voter.persona;
        return ballot;
      }
    }),
  );

  const tally = {
    refine: ballots.filter((ballot) => ballot.decision).length,
    proceed: ballots.filter((ballot) => !ballot.decision).length,
    total: ballots.length,
    majorityReached: false,
  };
  tally.majorityReached = tally.refine >= 2;

  return {
    proposition: input.proposition,
    ballots,
    tally,
    shouldRefine: tally.majorityReached,
    decision: tally.majorityReached,
  };
}

export function buildGateVotedEventData(result: QuorumVoteResult): EventData {
  return {
    proposition: result.proposition,
    decision: result.decision,
    isDone: result.isDone,
    tally: result.tally,
    ballots: result.ballots,
  };
}

function toBallot(voter: QuorumVoter, response: QuorumVoterResponse): QuorumVoterBallot {
  const ballot: QuorumVoterBallot = {
    voterId: voter.voterId,
    providerKind: voter.providerKind,
    decision: response.decision,
    reason: response.reason,
  };
  if (voter.persona) ballot.persona = voter.persona;
  if (response.rawOutput) ballot.rawOutput = response.rawOutput;
  return ballot;
}

function toScopeBallot(voter: QuorumVoter, response: ScopeVoterResponse): ScopeVoterBallot {
  const ballot: ScopeVoterBallot = {
    voterId: voter.voterId,
    providerKind: voter.providerKind,
    decision: response.decision,
    reason: response.reason,
  };
  if (voter.persona) ballot.persona = voter.persona;
  if (response.rawOutput) ballot.rawOutput = response.rawOutput;
  return ballot;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
