import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedDecisionsForReason,
  budgetGrantReasons,
  isConversationReason,
} from "./goal-input-request.types.js";

test("conversation reasons allow guidance, proceed, and abandon", () => {
  for (const reason of ["supervisor_question", "plan_confirmation"] as const) {
    assert.ok(isConversationReason(reason));
    assert.deepEqual(allowedDecisionsForReason(reason), ["provide_guidance", "proceed", "abandon"]);
  }
});

test("budget reasons allow extension; the circuit breaker does not", () => {
  assert.deepEqual(
    allowedDecisionsForReason("epoch_budget_exhausted"),
    ["extend_budget", "provide_guidance", "abandon"],
  );
  assert.deepEqual(
    allowedDecisionsForReason("reassessment_circuit_breaker"),
    ["provide_guidance", "abandon"],
  );
});

test("only budget-exhaustion reasons imply a grant; conversations never do", () => {
  assert.ok(budgetGrantReasons.includes("epoch_budget_exhausted"));
  assert.ok(budgetGrantReasons.includes("continuation_exhausted"));
  assert.ok(!budgetGrantReasons.includes("supervisor_question"));
  assert.ok(!budgetGrantReasons.includes("plan_confirmation"));
  assert.ok(!budgetGrantReasons.includes("reassessment_circuit_breaker"));
});
