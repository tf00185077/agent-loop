import assert from "node:assert/strict";
import test from "node:test";

import {
  plannerDecisionValues,
  type EventType,
  type QuorumGateDecision,
  type PlannerDecision,
  type PlannerScopeAssessment,
  type QuorumVoteDecision,
  type QuorumVoteResult,
  type QuorumVoteTally,
  type QuorumVoterBallot,
  type ScopeVoteDecision,
  type ScopeVoteResult,
  type ScopeVoteTally,
  type ScopeVoterBallot,
} from "./index.js";

test("planner decisions are a closed exported value set", () => {
  assert.deepEqual(plannerDecisionValues, [
    "IMPLEMENT_DIRECTLY",
    "DECOMPOSE",
    "NEEDS_OPENSPEC",
    "BLOCKED",
  ] satisfies PlannerDecision[]);
});

test("loop event types distinguish planner decisions, scope votes, and gate votes", () => {
  const loopEventTypes = ["agent.decision", "scope.voted", "gate.voted"] satisfies EventType[];

  assert.deepEqual(loopEventTypes, ["agent.decision", "scope.voted", "gate.voted"]);
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
    decision: "not_done",
  } satisfies QuorumVoteResult;
  const abstainDecision = "abstain" satisfies QuorumVoteDecision;
  const finalDecision = "not_done" satisfies QuorumGateDecision;

  assert.equal(result.ballots[0]?.providerKind, "codex-local");
  assert.equal(result.ballots[1]?.persona, "skeptic");
  assert.equal(result.tally.abstain, 1);
  assert.equal(result.isDone, false);
  assert.equal(result.decision, "not_done");
  assert.equal(abstainDecision, "abstain");
  assert.equal(finalDecision, "not_done");
});

test("scope assessment and vote types model binary refinement decisions", () => {
  const assessment = "too_large" satisfies PlannerScopeAssessment;
  const ballots = [
    {
      voterId: "codex-primary",
      providerKind: "codex-local",
      decision: true,
      reason: "The task still crosses too many files.",
      rawOutput: "REFINE: true",
    },
    {
      voterId: "fallback-skeptic",
      providerKind: "codex-local",
      persona: "skeptic",
      decision: false,
      reason: "The task is implementable as one step.",
    },
  ] satisfies ScopeVoterBallot[];
  const tally = {
    refine: 1,
    proceed: 1,
    total: 2,
    majorityReached: false,
  } satisfies ScopeVoteTally;
  const result = {
    proposition: "Is the current task still too large?",
    ballots,
    tally,
    shouldRefine: false,
    decision: false,
  } satisfies ScopeVoteResult;
  const finalDecision = false satisfies ScopeVoteDecision;

  assert.equal(assessment, "too_large");
  assert.equal(result.ballots[0]?.decision, true);
  assert.equal(result.tally.proceed, 1);
  assert.equal(result.shouldRefine, false);
  assert.equal(finalDecision, false);
});
