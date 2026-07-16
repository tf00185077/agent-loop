import assert from "node:assert/strict";
import test from "node:test";

import { GoalChangeRegistry, specTaskId } from "./change-registry.js";
import { GoalTaskRegistry } from "./task-registry.js";

const plan = [
  { id: "change-4v4", title: "4v4 mode", rationale: "Competitive.", dependsOn: ["change-core"] },
  { id: "change-core", title: "Core loop", rationale: "Foundation.", dependsOn: null },
];

function registryWithPlan() {
  const registry = new GoalChangeRegistry();
  assert.equal(registry.registerPlan(plan).ok, true);
  return registry;
}

test("orders changes by dependencies and activates the first as specifying", () => {
  const registry = registryWithPlan();

  assert.deepEqual(
    registry.listChanges().map((change) => [change.id, change.status]),
    [
      ["change-core", "specifying"],
      ["change-4v4", "planned"],
    ],
  );
  assert.equal(registry.activeChange()?.id, "change-core");
  assert.deepEqual(registry.getChange("change-core")?.taskIds, [specTaskId("change-core")]);
});

test("rejects a second plan for the same goal", () => {
  const registry = registryWithPlan();

  const second = registry.registerPlan(plan);

  assert.equal(second.ok, false);
  assert.match(second.ok ? "" : second.safeReason, /already exists/i);
});

test("resolves change ids by inheriting the active change and rejecting mismatches", () => {
  const registry = registryWithPlan();

  assert.deepEqual(registry.resolveChangeId(null), { ok: true, changeId: "change-core" });
  assert.deepEqual(registry.resolveChangeId("change-core"), { ok: true, changeId: "change-core" });
  const mismatch = registry.resolveChangeId("change-4v4");
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.ok ? "" : mismatch.safeReason, /change-core/);

  const planless = new GoalChangeRegistry();
  assert.deepEqual(planless.resolveChangeId(null), { ok: true, changeId: null });
});

test("gates archive on delivered tasks and merged evidence, then activates the next change", () => {
  const registry = registryWithPlan();
  const tasks = new GoalTaskRegistry();
  tasks.registerTaskList([
    { id: specTaskId("change-core"), title: "Write specs", acceptance: [{ id: "S1", text: "Valid." }] },
    { id: "task-1", title: "Implement", acceptance: [{ id: "A1", text: "Works." }] },
  ]);
  registry.registerTask("change-core", "task-1");

  const undone = registry.canArchive("change-core", tasks);
  assert.equal(undone.ok, false);
  assert.match(undone.ok ? "" : undone.safeReason, /undelivered tasks/);

  tasks.gateWorkerDelegation(specTaskId("change-core"), null);
  tasks.recordOutcome(specTaskId("change-core"), { kind: "success", safeSummary: "specs merged" });
  tasks.gateWorkerDelegation("task-1", null);
  tasks.recordOutcome("task-1", { kind: "success", safeSummary: "done" });
  registry.recordAttestedWorkerChanges("change-core");

  const unmerged = registry.canArchive("change-core", tasks);
  assert.equal(unmerged.ok, false);
  assert.match(unmerged.ok ? "" : unmerged.safeReason, /never review-merged/);

  registry.recordMerged("change-core");
  assert.deepEqual(registry.canArchive("change-core", tasks), { ok: true });

  registry.markArchived("change-core");
  assert.equal(registry.activeChange()?.id, "change-4v4");
  assert.equal(registry.getChange("change-4v4")?.status, "specifying");
  assert.equal(registry.allArchived(), false);
  registry.markArchived("change-4v4");
  assert.equal(registry.allArchived(), true);
});

test("registerPlan opens epoch 1 and tags its changes", () => {
  const registry = registryWithPlan();

  assert.deepEqual(registry.listEpochs(), [
    { sequence: 1, rationale: null, changeIds: ["change-core", "change-4v4"] },
  ]);
  assert.equal(registry.epochCount(), 1);
  assert.equal(registry.getChange("change-core")?.epochSequence, 1);
  assert.equal(registry.latestReassessment(), null);
  assert.equal(registry.pendingNextEpoch(), false);
});

test("recordReassessment gates on plan existence and all changes archived", () => {
  const planless = new GoalChangeRegistry();
  const noPlan = planless.recordReassessment({
    goalSatisfied: true,
    evidence: ["e"],
    remainingGaps: [],
    nextEpochRationale: null,
  });
  assert.equal(noPlan.ok, false);
  assert.match(noPlan.ok ? "" : noPlan.safeReason, /no change plan/i);

  const registry = registryWithPlan();
  const premature = registry.recordReassessment({
    goalSatisfied: false,
    evidence: ["e"],
    remainingGaps: ["gap"],
    nextEpochRationale: "r",
  });
  assert.equal(premature.ok, false);
  assert.match(premature.ok ? "" : premature.safeReason, /change-core/);

  registry.markArchived("change-core");
  registry.markArchived("change-4v4");
  const recorded = registry.recordReassessment({
    goalSatisfied: false,
    evidence: ["core delivered"],
    remainingGaps: ["missing multiplayer"],
    nextEpochRationale: "integration surfaced multiplayer gap",
  });
  assert.deepEqual(recorded, { ok: true });
  assert.equal(registry.latestReassessment()?.epochSequence, 1);
  assert.equal(registry.latestReassessment()?.goalSatisfied, false);
  assert.equal(registry.pendingNextEpoch(), true);
});

test("registerNextEpoch requires a pending unsatisfied reassessment and unique change ids", () => {
  const registry = registryWithPlan();
  const early = registry.registerNextEpoch([{ id: "change-next", title: "Next", rationale: "r", dependsOn: null }]);
  assert.equal(early.ok, false);
  assert.match(early.ok ? "" : early.safeReason, /reassessment/i);

  registry.markArchived("change-core");
  registry.markArchived("change-4v4");
  registry.recordReassessment({
    goalSatisfied: false,
    evidence: ["e"],
    remainingGaps: ["gap"],
    nextEpochRationale: "found gap",
  });

  const collision = registry.registerNextEpoch([
    { id: "change-core", title: "Reused id", rationale: "r", dependsOn: null },
  ]);
  assert.equal(collision.ok, false);
  assert.match(collision.ok ? "" : collision.safeReason, /change-core/);

  const accepted = registry.registerNextEpoch([
    { id: "change-next", title: "Next batch", rationale: "r", dependsOn: null },
  ]);
  assert.deepEqual(accepted, { ok: true });
  assert.equal(registry.epochCount(), 2);
  assert.deepEqual(registry.listEpochs()[1], {
    sequence: 2,
    rationale: "found gap",
    changeIds: ["change-next"],
  });
  assert.equal(registry.getChange("change-next")?.status, "specifying");
  assert.equal(registry.getChange("change-next")?.epochSequence, 2);
  assert.equal(registry.activeChange()?.id, "change-next");
  assert.equal(registry.allArchived(), false);
  assert.equal(registry.pendingNextEpoch(), false);

  // The gate is consumed: another plan needs another unsatisfied reassessment.
  const second = registry.registerNextEpoch([{ id: "change-more", title: "More", rationale: "r", dependsOn: null }]);
  assert.equal(second.ok, false);

  registry.markArchived("change-next");
  assert.equal(registry.allArchived(), true);
  registry.recordReassessment({
    goalSatisfied: true,
    evidence: ["all gaps closed"],
    remainingGaps: [],
    nextEpochRationale: null,
  });
  assert.equal(registry.latestReassessment()?.goalSatisfied, true);
  assert.equal(registry.latestReassessment()?.epochSequence, 2);
  assert.equal(registry.pendingNextEpoch(), false);
});

test("a satisfied reassessment does not arm the next-epoch gate", () => {
  const registry = registryWithPlan();
  registry.markArchived("change-core");
  registry.markArchived("change-4v4");
  registry.recordReassessment({
    goalSatisfied: true,
    evidence: ["e"],
    remainingGaps: [],
    nextEpochRationale: null,
  });

  const rejected = registry.registerNextEpoch([{ id: "change-next", title: "N", rationale: "r", dependsOn: null }]);
  assert.equal(rejected.ok, false);
});

test("split tasks count as delivered through their descendants", () => {
  const registry = registryWithPlan();
  const tasks = new GoalTaskRegistry();
  tasks.registerTaskList([
    { id: specTaskId("change-core"), title: "Specs", acceptance: [{ id: "S1", text: "Valid." }] },
    {
      id: "task-1", title: "Big task",
      acceptance: [{ id: "A1", text: "Works." }, { id: "A2", text: "Also works." }],
    },
  ]);
  registry.registerTask("change-core", "task-1");
  tasks.gateWorkerDelegation(specTaskId("change-core"), null);
  tasks.recordOutcome(specTaskId("change-core"), { kind: "success", safeSummary: "ok" });
  tasks.getTask("task-1")!.status = "split";
  tasks.registerTaskList([
    { id: "task-1a", title: "Narrow", acceptance: [{ id: "A1", text: "Works." }], parentTaskId: "task-1" },
  ]);

  assert.equal(registry.canArchive("change-core", tasks).ok, false);
  tasks.gateWorkerDelegation("task-1a", null);
  tasks.recordOutcome("task-1a", { kind: "success", safeSummary: "done" });
  assert.deepEqual(registry.canArchive("change-core", tasks), { ok: true });
});

test("archive fails closed with a structured reason when cache lineage is inconsistent", () => {
  const registry = registryWithPlan();
  const tasks = new GoalTaskRegistry();
  tasks.registerTaskList([
    { id: specTaskId("change-core"), title: "Specs", acceptance: [{ id: "S1", text: "Valid." }] },
    { id: "parent", title: "Parent", acceptance: [{ id: "A1", text: "One" }, { id: "A2", text: "Two" }] },
  ]);
  registry.registerTask("change-core", "parent");
  tasks.getTask("parent")!.status = "failed";
  tasks.getTask("parent")!.substantiveRejections = 2;
  tasks.registerTaskList([
    { id: "child", title: "Child", acceptance: [{ id: "A1", text: "One" }], parentTaskId: "parent" },
  ]);
  tasks.getTask("parent")!.status = "failed";
  tasks.getTask("child")!.status = "done";

  const gate = registry.canArchive("change-core", tasks);

  assert.equal(gate.ok, false);
  assert.match(gate.ok ? "" : gate.safeReason, /invalid split lineage.*parent_not_split/i);
});
