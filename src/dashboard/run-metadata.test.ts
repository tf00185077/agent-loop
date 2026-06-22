import { test } from "node:test";
import assert from "node:assert/strict";

import type { GoalEvent } from "./api.js";
import {
  eventRunMetadata,
  latestRunMetadata,
} from "./run-metadata.js";

test("latestRunMetadata returns the newest displayable provider and model", () => {
  const events = [
    event("run.started", { provider: "mock", model: "mock-v1" }, "2026-06-22T01:00:00.000Z"),
    event("step.started", { stepId: "step-1" }, "2026-06-22T01:01:00.000Z"),
    event("error", { provider: "codex-cli", model: "gpt-5-codex" }, "2026-06-22T01:02:00.000Z"),
  ];

  assert.deepEqual(latestRunMetadata(events), {
    provider: "codex-cli",
    model: "gpt-5-codex",
  });
});

test("metadata helpers tolerate historical events without provider or model", () => {
  const events = [
    event("goal.created", { goalId: "goal-1" }, "2026-06-22T01:00:00.000Z"),
    event("run.started", { provider: "mock" }, "2026-06-22T01:01:00.000Z"),
  ];

  assert.equal(eventRunMetadata(events[0]), null);
  assert.equal(eventRunMetadata(events[1]), null);
  assert.equal(latestRunMetadata(events), null);
});

function event(type: string, data: Record<string, unknown>, createdAt: string): GoalEvent {
  return {
    id: `${type}-${createdAt}`,
    goalId: "goal-1",
    runId: "run-1",
    stepId: null,
    type,
    message: `${type} message`,
    data,
    createdAt,
  };
}
