import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGateVotedEventData,
  resolveQuorumVoters,
  runQuorumVote,
} from "./quorum-voters.js";

test("resolveQuorumVoters prefers three distinct configured providers", () => {
  assert.deepEqual(
    resolveQuorumVoters({
      availableProviders: ["claude-local", "codex-local", "openai-compatible"],
      fallbackProvider: "codex-local",
    }),
    [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "claude-local", providerKind: "claude-local" },
      { voterId: "openai-compatible", providerKind: "openai-compatible" },
    ],
  );
});

test("resolveQuorumVoters fills missing providers with persona fallbacks", () => {
  assert.deepEqual(
    resolveQuorumVoters({
      availableProviders: ["codex-local"],
      fallbackProvider: "codex-local",
    }),
    [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "codex-local-skeptic", providerKind: "codex-local", persona: "skeptic" },
      { voterId: "codex-local-optimist", providerKind: "codex-local", persona: "optimist" },
    ],
  );
});

test("resolveQuorumVoters deduplicates providers and preserves priority order", () => {
  assert.deepEqual(
    resolveQuorumVoters({
      availableProviders: ["openai-compatible", "codex-local", "codex-local"],
      fallbackProvider: "openai-compatible",
    }),
    [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "openai-compatible", providerKind: "openai-compatible" },
      {
        voterId: "openai-compatible-skeptic",
        providerKind: "openai-compatible",
        persona: "skeptic",
      },
    ],
  );
});

test("runQuorumVote runs voters in parallel and tallies majority done", async () => {
  const started: string[] = [];
  let releaseFirstVote = () => {};
  const firstVoteStarted = new Promise<void>((resolve) => {
    releaseFirstVote = resolve;
  });

  const resultPromise = runQuorumVote({
    proposition: "Does the result satisfy the goal?",
    voters: [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "claude-local", providerKind: "claude-local" },
      { voterId: "openai-compatible", providerKind: "openai-compatible" },
    ],
    vote: async (voter) => {
      started.push(voter.voterId);
      if (voter.voterId === "codex-local") {
        await firstVoteStarted;
      }
      return {
        decision: voter.voterId === "openai-compatible" ? "not_done" : "done",
        reason: `${voter.voterId} voted`,
        rawOutput: `${voter.voterId}: ${voter.voterId === "openai-compatible" ? "NO" : "YES"}`,
      };
    },
  });

  await Promise.resolve();
  assert.deepEqual(started, ["codex-local", "claude-local", "openai-compatible"]);
  releaseFirstVote();

  assert.deepEqual(await resultPromise, {
    proposition: "Does the result satisfy the goal?",
    isDone: true,
    decision: "done",
    tally: {
      done: 2,
      notDone: 1,
      abstain: 0,
      total: 3,
      majorityReached: true,
    },
    ballots: [
      {
        voterId: "codex-local",
        providerKind: "codex-local",
        decision: "done",
        reason: "codex-local voted",
        rawOutput: "codex-local: YES",
      },
      {
        voterId: "claude-local",
        providerKind: "claude-local",
        decision: "done",
        reason: "claude-local voted",
        rawOutput: "claude-local: YES",
      },
      {
        voterId: "openai-compatible",
        providerKind: "openai-compatible",
        decision: "not_done",
        reason: "openai-compatible voted",
        rawOutput: "openai-compatible: NO",
      },
    ],
  });
});

test("runQuorumVote maps voter errors to abstain counted as not done", async () => {
  const result = await runQuorumVote({
    proposition: "Does the result satisfy the goal?",
    voters: [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "claude-local", providerKind: "claude-local" },
      { voterId: "openai-compatible", providerKind: "openai-compatible" },
    ],
    vote: async (voter) => {
      if (voter.voterId === "claude-local") throw new Error("timeout");
      return {
        decision: "not_done",
        reason: `${voter.voterId} needs more work`,
      };
    },
  });

  assert.equal(result.isDone, false);
  assert.equal(result.decision, "not_done");
  assert.deepEqual(result.tally, {
    done: 0,
    notDone: 2,
    abstain: 1,
    total: 3,
    majorityReached: false,
  });
  assert.deepEqual(result.ballots[1], {
    voterId: "claude-local",
    providerKind: "claude-local",
    decision: "abstain",
    reason: "Voter failed: timeout",
    error: "timeout",
  });
});

test("buildGateVotedEventData records ballots and the final majority decision", async () => {
  const result = await runQuorumVote({
    proposition: "Does the result satisfy the goal?",
    voters: [
      { voterId: "codex-local", providerKind: "codex-local" },
      { voterId: "claude-local", providerKind: "claude-local" },
      { voterId: "codex-local-skeptic", providerKind: "codex-local", persona: "skeptic" },
    ],
    vote: async (voter) => ({
      decision: voter.voterId === "codex-local" ? "done" : "not_done",
      reason: `${voter.voterId} voted`,
    }),
  });

  assert.deepEqual(buildGateVotedEventData(result), {
    proposition: "Does the result satisfy the goal?",
    decision: "not_done",
    isDone: false,
    tally: {
      done: 1,
      notDone: 2,
      abstain: 0,
      total: 3,
      majorityReached: false,
    },
    ballots: [
      {
        voterId: "codex-local",
        providerKind: "codex-local",
        decision: "done",
        reason: "codex-local voted",
      },
      {
        voterId: "claude-local",
        providerKind: "claude-local",
        decision: "not_done",
        reason: "claude-local voted",
      },
      {
        voterId: "codex-local-skeptic",
        providerKind: "codex-local",
        persona: "skeptic",
        decision: "not_done",
        reason: "codex-local-skeptic voted",
      },
    ],
  });
});
