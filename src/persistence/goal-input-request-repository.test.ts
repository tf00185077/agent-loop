import assert from "node:assert/strict";
import test from "node:test";

import { allowedDecisionsForReason } from "../domain/index.js";
import { openDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";
import { createGoalInputRequestRepository } from "./goal-input-request-repository.js";

function setup() {
  const db = openDatabase({ path: ":memory:" });
  const goals = createGoalRepository(db);
  const goal = goals.create({ title: "Escalation goal", description: "test" });
  const repo = createGoalInputRequestRepository(db);
  return { db, goal, repo };
}

function requestInput(goalId: string) {
  return {
    goalId,
    reasonCode: "epoch_budget_exhausted" as const,
    safeSummary: "Planning-epoch budget exhausted with gaps remaining.",
    payload: {
      budgetName: "planning_epochs" as const,
      budgetValue: 5,
      evidence: ["All epoch-5 changes archived."],
      remainingGaps: [{ refs: ["new:reporting"], summary: "Reporting scope missing" }],
      allowedDecisions: allowedDecisionsForReason("epoch_budget_exhausted"),
    },
  };
}

test("creates a pending request and reads it back with payload intact", () => {
  const { goal, repo } = setup();
  const created = repo.createRequest(requestInput(goal.id));

  assert.equal(created.status, "pending");
  assert.equal(created.reasonCode, "epoch_budget_exhausted");
  assert.equal(created.response, null);
  assert.equal(created.resolvedAt, null);

  const pending = repo.getPending(goal.id);
  assert.ok(pending);
  assert.equal(pending.id, created.id);
  assert.deepEqual(pending.payload, requestInput(goal.id).payload);
});

test("enforces at most one pending request per goal", () => {
  const { goal, repo } = setup();
  repo.createRequest(requestInput(goal.id));
  assert.throws(() => repo.createRequest(requestInput(goal.id)), /pending/i);
});

test("resolve transitions pending to accepted with the response recorded", () => {
  const { goal, repo } = setup();
  const created = repo.createRequest(requestInput(goal.id));
  const resolved = repo.resolve(created.id, "accepted", { decision: "extend_budget", extension: 2 });

  assert.equal(resolved.status, "accepted");
  assert.deepEqual(resolved.response, { decision: "extend_budget", extension: 2 });
  assert.ok(resolved.resolvedAt);
  assert.equal(repo.getPending(goal.id), null);
});

test("resolve rejects a non-pending request", () => {
  const { goal, repo } = setup();
  const created = repo.createRequest(requestInput(goal.id));
  repo.resolve(created.id, "abandoned", { decision: "abandon", reason: null });
  assert.throws(
    () => repo.resolve(created.id, "accepted", { decision: "provide_guidance", guidance: "retry" }),
    /not pending/i,
  );
});

test("a resolved request allows a new pending request for the same goal", () => {
  const { goal, repo } = setup();
  const first = repo.createRequest(requestInput(goal.id));
  repo.resolve(first.id, "accepted", { decision: "extend_budget", extension: 1 });
  const second = repo.createRequest(requestInput(goal.id));
  assert.notEqual(second.id, first.id);
  assert.equal(repo.getPending(goal.id)?.id, second.id);
});

test("listForGoal returns chronological history and sums accepted grants", () => {
  const { goal, repo } = setup();
  const first = repo.createRequest(requestInput(goal.id));
  repo.resolve(first.id, "accepted", { decision: "extend_budget", extension: 2 });
  const second = repo.createRequest(requestInput(goal.id));
  repo.resolve(second.id, "accepted", { decision: "provide_guidance", guidance: "focus on reporting" });

  const history = repo.listForGoal(goal.id);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.id, first.id);

  assert.equal(repo.sumAcceptedExtensions(goal.id, "planning_epochs"), 3);
  assert.equal(repo.sumAcceptedExtensions(goal.id, "supervisor_continuations"), 0);
});
