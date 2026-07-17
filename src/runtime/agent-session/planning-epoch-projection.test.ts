import assert from "node:assert/strict";
import test from "node:test";

import type { Event } from "../../domain/index.js";
import { projectPlanningEpochs } from "./planning-epoch-projection.js";

let sequence = 0;
function event(data: Record<string, unknown>): Event {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    goalId: "goal-1",
    runId: "run-1",
    stepId: null,
    type: "agent.progress",
    message: "m",
    data,
    createdAt: `2026-07-13T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

test("returns no epochs for goals without a change plan", () => {
  assert.deepEqual(projectPlanningEpochs([event({ runtimeEventType: "supervisor.task_list" })]), []);
});

test("projects epochs, change statuses, and reassessments from durable events", () => {
  const events: Event[] = [
    event({
      runtimeEventType: "supervisor.change_plan",
      epochSequence: 1,
      changePlan: [
        { id: "c1", title: "Core", rationale: "r1" },
        { id: "c2", title: "Modes", rationale: "r2", dependsOn: ["c1"] },
      ],
    }),
    event({ runtimeEventType: "change.activated", changeId: "c1" }),
    event({ runtimeEventType: "change.spec_approved", changeId: "c1" }),
    event({ runtimeEventType: "change.archived", changeId: "c1" }),
    event({ runtimeEventType: "change.activated", changeId: "c2" }),
    event({ runtimeEventType: "change.archived", changeId: "c2" }),
    event({
      runtimeEventType: "supervisor.reassessment",
      epochSequence: 1,
      goalSatisfied: false,
      evidence: ["core delivered"],
      remainingGaps: ["verification missing"],
      nextEpochRationale: "integration surfaced a gap",
    }),
    event({
      runtimeEventType: "supervisor.change_plan",
      epochSequence: 2,
      epochRationale: "integration surfaced a gap",
      changePlan: [{ id: "c3", title: "Verification", rationale: "r3" }],
    }),
    event({ runtimeEventType: "change.activated", changeId: "c3" }),
    event({ runtimeEventType: "change.spec_approved", changeId: "c3" }),
  ];

  const epochs = projectPlanningEpochs(events);

  assert.equal(epochs.length, 2);
  const [first, second] = epochs;
  assert.equal(first!.sequence, 1);
  assert.equal(first!.rationale, null);
  assert.equal(first!.status, "gaps_found");
  assert.deepEqual(first!.changes, [
    { id: "c1", title: "Core", status: "archived" },
    { id: "c2", title: "Modes", status: "archived" },
  ]);
  assert.deepEqual(first!.reassessment, {
    goalSatisfied: false,
    evidence: ["core delivered"],
    remainingGaps: ["verification missing"],
    nextEpochRationale: "integration surfaced a gap",
  });

  assert.equal(second!.sequence, 2);
  assert.equal(second!.rationale, "integration surfaced a gap");
  assert.equal(second!.status, "executing");
  assert.deepEqual(second!.changes, [{ id: "c3", title: "Verification", status: "executing" }]);
  assert.equal(second!.reassessment, null);
});

test("derives reassessing, completed, and blocked epoch statuses", () => {
  const reassessing = projectPlanningEpochs([
    event({
      runtimeEventType: "supervisor.change_plan",
      epochSequence: 1,
      changePlan: [{ id: "c1", title: "Core", rationale: "r" }],
    }),
    event({ runtimeEventType: "change.archived", changeId: "c1" }),
  ]);
  assert.equal(reassessing[0]!.status, "reassessing");

  const completed = projectPlanningEpochs([
    event({
      runtimeEventType: "supervisor.change_plan",
      epochSequence: 1,
      changePlan: [{ id: "c1", title: "Core", rationale: "r" }],
    }),
    event({ runtimeEventType: "change.archived", changeId: "c1" }),
    event({
      runtimeEventType: "supervisor.reassessment",
      epochSequence: 1,
      goalSatisfied: true,
      evidence: ["done"],
    }),
  ]);
  assert.equal(completed[0]!.status, "completed");
  assert.deepEqual(completed[0]!.reassessment?.remainingGaps, []);

  const blocked = projectPlanningEpochs([
    event({
      runtimeEventType: "supervisor.change_plan",
      epochSequence: 1,
      changePlan: [{ id: "c1", title: "Core", rationale: "r" }],
    }),
    event({ runtimeEventType: "change.blocked", changeId: "c1" }),
  ]);
  assert.equal(blocked[0]!.status, "blocked");
});
