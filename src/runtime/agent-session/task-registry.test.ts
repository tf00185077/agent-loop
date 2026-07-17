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

test("registering the first child set atomically splits an eligible parent", () => {
  const registry = registryWithTask();
  const parent = registry.getTask("task-1")!;
  parent.status = "failed";
  parent.attemptCount = 2;
  parent.substantiveRejections = 2;
  parent.lastCitedCriteria = ["A1"];

  const result = registry.registerTaskList([
    {
      id: "task-1a",
      title: "Second player join only",
      acceptance: [{ id: "A1", text: "Two players can join the same lobby." }],
      parentTaskId: "task-1",
    },
    {
      id: "task-1b",
      title: "Third player rejection only",
      acceptance: [{ id: "A2", text: "Lobby rejects a third player." }],
      parentTaskId: "task-1",
    },
  ]);

  assert.equal(registry.getTask("task-1")?.status, "split");
  assert.deepEqual(result.tasks.map((task) => task.parentTaskId), ["task-1", "task-1"]);
});

test("direct narrowing follows two substantive review rejections without a redundant parent delegation", () => {
  const registry = registryWithTask();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(registry.gateWorkerDelegation("task-1", null).ok, true);
    registry.recordOutcome("task-1", { kind: "success", safeSummary: "Worker claim" });
    registry.classifyVerdict("task-1", `Review ${attempt + 1}: A1 still fails.`);
  }

  registry.registerTaskList([{
    id: "task-1a",
    title: "Second player join only",
    acceptance: [criteria[0]!],
    parentTaskId: "task-1",
  }]);

  assert.equal(registry.getTask("task-1")?.status, "split");
  assert.equal(registry.getTask("task-1a")?.parentTaskId, "task-1");
});

test("invalid child registration leaves the entire in-memory graph unchanged", () => {
  const registry = registryWithTask();
  const parent = registry.getTask("task-1")!;
  parent.status = "failed";
  parent.substantiveRejections = 2;
  const before = structuredClone(registry.listTasks());

  assert.throws(() => registry.registerTaskList([
    {
      id: "task-1a",
      title: "Valid sibling",
      acceptance: [{ id: "A1", text: "Two players can join the same lobby." }],
      parentTaskId: "task-1",
    },
    {
      id: "task-1b",
      title: "Invalid sibling",
      acceptance: criteria,
      parentTaskId: "task-1",
    },
  ]), /narrower/i);
  assert.deepEqual(registry.listTasks(), before);
});

test("rejects child registration for an ineligible or self-parented task", () => {
  const belowThreshold = registryWithTask();
  assert.throws(() => belowThreshold.registerTaskList([{
    id: "task-1a", title: "Too early", acceptance: [criteria[0]!], parentTaskId: "task-1",
  }]), /retry|threshold/i);

  const active = registryWithTask();
  active.getTask("task-1")!.substantiveRejections = 2;
  active.getTask("task-1")!.status = "delegated";
  assert.throws(() => active.registerTaskList([{
    id: "task-1a", title: "While active", acceptance: [criteria[0]!], parentTaskId: "task-1",
  }]), /active|delegated/i);

  const selfParent = registryWithTask();
  selfParent.getTask("task-1")!.substantiveRejections = 2;
  selfParent.getTask("task-1")!.status = "failed";
  assert.throws(() => selfParent.registerTaskList([{
    id: "task-1", title: "Cycle", acceptance: [criteria[0]!], parentTaskId: "task-1",
  }]), /cycle|itself|self/i);
});

test("rejects empty, duplicate, and non-smaller child contracts atomically", () => {
  for (const proposed of [
    [
      { id: "task-1a", title: "No contract", acceptance: [], parentTaskId: "task-1" },
    ],
    [
      { id: "task-1a", title: "First copy", acceptance: [criteria[0]!], parentTaskId: "task-1" },
      { id: "task-1a", title: "Second copy", acceptance: [criteria[1]!], parentTaskId: "task-1" },
    ],
    [
      { id: "task-1a", title: "Same size", acceptance: criteria, parentTaskId: "task-1" },
    ],
  ]) {
    const registry = registryWithTask();
    const parent = registry.getTask("task-1")!;
    parent.status = "failed";
    parent.substantiveRejections = 2;
    const before = structuredClone(registry.listTasks());

    assert.throws(() => registry.registerTaskList(proposed), /contract|duplicate|narrower/i);
    assert.deepEqual(registry.listTasks(), before);
  }
});

test("does not attach a child to a missing parent", () => {
  const registry = registryWithTask();
  const before = structuredClone(registry.listTasks());

  assert.throws(() => registry.registerTaskList([{
    id: "orphan", title: "Orphan", acceptance: [criteria[0]!], parentTaskId: "missing-parent",
  }]), /parent.*not found|missing parent/i);
  assert.deepEqual(registry.listTasks(), before);
});

test("freezes an exact split child set after idempotent re-announcement", () => {
  const registry = registryWithTask();
  const parent = registry.getTask("task-1")!;
  parent.status = "failed";
  parent.substantiveRejections = 2;
  const child = {
    id: "task-1a",
    title: "Second player join only",
    acceptance: [criteria[0]!],
    parentTaskId: "task-1",
  };

  registry.registerTaskList([child]);
  assert.doesNotThrow(() => registry.registerTaskList([child]));
  assert.throws(() => registry.registerTaskList([{
    id: "task-1b", title: "Late child", acceptance: [criteria[1]!], parentTaskId: "task-1",
  }]), /frozen|descendant|child set/i);
  assert.equal(registry.getTask("task-1b"), undefined);
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
