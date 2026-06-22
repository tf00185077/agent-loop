import assert from "node:assert/strict";
import test from "node:test";

import type { Event } from "../domain/index.js";
import { createEventBus } from "./event-bus.js";

function fakeEvent(goalId: string, overrides: Partial<Event> = {}): Event {
  return {
    id: "event-1",
    goalId,
    runId: null,
    stepId: null,
    type: "agent.message",
    message: "hello",
    data: {},
    createdAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

test("subscribers receive events published for their goal", () => {
  const bus = createEventBus();
  const received: Event[] = [];
  bus.subscribe("goal-1", (event) => received.push(event));

  bus.publish(fakeEvent("goal-1"));

  assert.equal(received.length, 1);
  assert.equal(received[0]?.goalId, "goal-1");
});

test("subscribers do not receive events published for other goals", () => {
  const bus = createEventBus();
  const received: Event[] = [];
  bus.subscribe("goal-1", (event) => received.push(event));

  bus.publish(fakeEvent("goal-2"));

  assert.equal(received.length, 0);
});

test("unsubscribe stops further delivery", () => {
  const bus = createEventBus();
  const received: Event[] = [];
  const unsubscribe = bus.subscribe("goal-1", (event) => received.push(event));

  unsubscribe();
  bus.publish(fakeEvent("goal-1"));

  assert.equal(received.length, 0);
});

test("multiple subscribers for the same goal all receive the event", () => {
  const bus = createEventBus();
  const a: Event[] = [];
  const b: Event[] = [];
  bus.subscribe("goal-1", (event) => a.push(event));
  bus.subscribe("goal-1", (event) => b.push(event));

  bus.publish(fakeEvent("goal-1"));

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});
