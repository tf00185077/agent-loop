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

test("split tasks count as delivered through their descendants", () => {
  const registry = registryWithPlan();
  const tasks = new GoalTaskRegistry();
  tasks.registerTaskList([
    { id: specTaskId("change-core"), title: "Specs", acceptance: [{ id: "S1", text: "Valid." }] },
    { id: "task-1", title: "Big task", acceptance: [{ id: "A1", text: "Works." }] },
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
