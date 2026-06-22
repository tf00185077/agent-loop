import assert from "node:assert/strict";
import test from "node:test";

import {
  plannerDecisionValues,
  type EventType,
  type PlannerDecision,
  type QuorumVoteDecision,
  type QuorumVoteResult,
  type QuorumVoteTally,
  type QuorumVoterBallot,
} from "./index.js";

test("planner decisions are a closed exported value set", () => {
  assert.deepEqual(plannerDecisionValues, [
    "IMPLEMENT_DIRECTLY",
    "DECOMPOSE",
    "NEEDS_OPENSPEC",
    "BLOCKED",
  ] satisfies PlannerDecision[]);
});

test("loop event types include planner decisions and gate votes", () => {
  const loopEventTypes = ["agent.decision", "gate.voted"] satisfies EventType[];

  assert.deepEqual(loopEventTypes, ["agent.decision", "gate.voted"]);
});

test("quorum vote types model ballots and the final tally", () => {
  const ballots = [
    {
      voterId: "codex-primary",
      providerKind: "codex-local",
      decision: "done",
      reason: "The acceptance criteria are satisfied.",
      rawOutput: "DONE: yes",
    },
    {
      voterId: "fallback-skeptic",
      providerKind: "codex-local",
      persona: "skeptic",
      decision: "abstain",
      reason: "Provider timed out.",
      error: "timeout",
    },
  ] satisfies QuorumVoterBallot[];
  const tally = {
    done: 1,
    notDone: 0,
    abstain: 1,
    total: 2,
    majorityReached: false,
  } satisfies QuorumVoteTally;
  const result = {
    proposition: "Does the current result satisfy the goal?",
    ballots,
    tally,
    isDone: false,
  } satisfies QuorumVoteResult;
  const abstainDecision = "abstain" satisfies QuorumVoteDecision;

  assert.equal(result.ballots[0]?.providerKind, "codex-local");
  assert.equal(result.ballots[1]?.persona, "skeptic");
  assert.equal(result.tally.abstain, 1);
  assert.equal(result.isDone, false);
  assert.equal(abstainDecision, "abstain");
});
