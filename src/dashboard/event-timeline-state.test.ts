import { test } from "node:test";
import assert from "node:assert/strict";

import type { GoalEvent } from "./api.js";
import { appendEvent, isTerminalEvent } from "./event-timeline-state.js";

test("appendEvent adds a new event to the end of the list", () => {
  const events = [event("e1", "run.started")];
  const next = appendEvent(events, event("e2", "agent.progress"));

  assert.deepEqual(next.map((e) => e.id), ["e1", "e2"]);
});

test("appendEvent ignores an event whose id already exists", () => {
  const events = [event("e1", "run.started"), event("e2", "agent.progress")];
  const next = appendEvent(events, event("e2", "agent.progress"));

  assert.equal(next, events);
});

test("isTerminalEvent recognizes goal.completed, goal.blocked, and error", () => {
  assert.equal(isTerminalEvent(event("e1", "goal.completed")), true);
  assert.equal(isTerminalEvent(event("e2", "goal.blocked")), true);
  assert.equal(isTerminalEvent(event("e3", "error")), true);
});

test("isTerminalEvent returns false for non-terminal event types", () => {
  assert.equal(isTerminalEvent(event("e1", "agent.progress")), false);
  assert.equal(isTerminalEvent(event("e2", "run.started")), false);
});

function event(id: string, type: string): GoalEvent {
  return {
    id,
    goalId: "goal-1",
    runId: "run-1",
    stepId: null,
    type,
    message: `${type} message`,
    data: {},
    createdAt: "2026-06-25T00:00:00.000Z",
  };
}
