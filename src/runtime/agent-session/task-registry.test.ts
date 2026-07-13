import assert from "node:assert/strict";
import test from "node:test";

import { GoalTaskRegistry } from "./task-registry.js";

const criteria = [
  { id: "A1", text: "Two players can join the same lobby." },
  { id: "A2", text: "Lobby rejects a third player." },
];

function registryWithTask() {
  const registry = new GoalTaskRegistry();
  registry.registerTaskList([{ id: "task-1", title: "Matchmaking", acceptance: criteria }]);
  return registry;
}

test("freezes criteria at announcement and ignores later mutations", () => {
  const registry = registryWithTask();

  const second = registry.registerTaskList([
    {
      id: "task-1",
      title: "Matchmaking",
      acceptance: [{ id: "A1", text: "Rewritten standard." }],
    },
  ]);

  assert.deepEqual(second.ignoredMutations, ["task-1"]);
  assert.deepEqual(registry.getTask("task-1")?.acceptance, criteria);
});

test("rejects worker delegation for a known task without a contract", () => {
  const registry = new GoalTaskRegistry();
  registry.registerTaskList([{ id: "task-1", title: "No contract yet" }]);

  const gate = registry.gateWorkerDelegation("task-1", null);

  assert.equal(gate.ok, false);
  assert.match(gate.ok ? "" : gate.safeReason, /no acceptance contract/i);
});

test("freezes first-use criteria supplied on the delegation itself", () => {
  const registry = new GoalTaskRegistry();
  registry.registerTaskList([{ id: "task-1", title: "No contract yet" }]);

  const gate = registry.gateWorkerDelegation("task-1", criteria);

  assert.equal(gate.ok, true);
  assert.deepEqual(registry.getTask("task-1")?.acceptance, criteria);
  // A later delegation cannot rewrite them.
  registry.recordOutcome("task-1", { kind: "failure", safeSummary: "failed" });
  const second = registry.gateWorkerDelegation("task-1", [{ id: "B1", text: "Other." }]);
  assert.equal(second.ok, true);
  assert.deepEqual(second.ok ? second.acceptance : null, criteria);
});

test("marks delegations without a task id as uncontracted but allowed", () => {
  const registry = new GoalTaskRegistry();

  const gate = registry.gateWorkerDelegation(null, null);

  assert.deepEqual(gate, { ok: true, acceptance: null, uncontracted: true });
});

test("counts only criterion-citing verdicts as substantive", () => {
  const registry = registryWithTask();

  const substantive = registry.classifyVerdict("task-1", "Rejected: A2 not satisfied, lobby admits a third player.");
  const uncited = registry.classifyVerdict("task-1", "I do not like the naming style here.");

  assert.equal(substantive.substantive, true);
  assert.deepEqual(substantive.citedCriteria, ["A2"]);
  assert.equal(uncited.substantive, false);
  assert.equal(uncited.deferredFinding, "I do not like the naming style here.");
  assert.equal(registry.getTask("task-1")?.substantiveRejections, 1);
  assert.equal(registry.getTask("task-1")?.criterionOutcomes.A2, "failed");
});

test("refuses the third identical-scope delegation after two substantive rejections", () => {
  const registry = registryWithTask();

  assert.equal(registry.gateWorkerDelegation("task-1", null).ok, true);
  registry.recordOutcome("task-1", { kind: "success", safeSummary: "claims done" });
  registry.classifyVerdict("task-1", "A1 fails: second player cannot join.");
  assert.equal(registry.gateWorkerDelegation("task-1", null).ok, true);
  registry.recordOutcome("task-1", { kind: "success", safeSummary: "claims done again" });
  registry.classifyVerdict("task-1", "A1 still fails after retry.");

  const third = registry.gateWorkerDelegation("task-1", null);

  assert.equal(third.ok, false);
  assert.match(third.ok ? "" : third.safeReason, /split/i);
  assert.match(third.ok ? "" : third.safeReason, /A1/);
  assert.equal(registry.getTask("task-1")?.status, "split");
});

test("accepts narrower split tasks with lineage to the failed parent", () => {
  const registry = registryWithTask();
  registry.getTask("task-1")!.status = "split";

  const result = registry.registerTaskList([
    {
      id: "task-1a",
      title: "Second player join only",
      acceptance: [{ id: "A1", text: "Two players can join the same lobby." }],
      parentTaskId: "task-1",
    },
  ]);

  assert.equal(result.tasks[0]?.parentTaskId, "task-1");
  const gate = registry.gateWorkerDelegation("task-1a", null);
  assert.equal(gate.ok, true);
  const parentGate = registry.gateWorkerDelegation("task-1", null);
  assert.equal(parentGate.ok, false);
  assert.match(parentGate.ok ? "" : parentGate.safeReason, /narrower tasks/i);
});

test("bounds attempt loops even without substantive rejections", () => {
  const registry = registryWithTask();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(registry.gateWorkerDelegation("task-1", null).ok, true);
    registry.recordOutcome("task-1", { kind: "failure", safeSummary: `attempt ${attempt + 1} crashed` });
  }
  const fourth = registry.gateWorkerDelegation("task-1", null);

  assert.equal(fourth.ok, false);
  assert.match(fourth.ok ? "" : fourth.safeReason, /retry budget/i);
});

test("records passed criteria from structured success evidence", () => {
  const registry = registryWithTask();
  registry.gateWorkerDelegation("task-1", null);

  registry.recordOutcome("task-1", {
    kind: "success",
    safeSummary: "done",
    criterionEvidence: [{ criterionId: "A1", evidence: "Two joined in test." }],
  });

  const task = registry.getTask("task-1");
  assert.equal(task?.status, "done");
  assert.equal(task?.criterionOutcomes.A1, "passed");
  assert.equal(task?.criterionOutcomes.A2, "unknown");
});
