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
