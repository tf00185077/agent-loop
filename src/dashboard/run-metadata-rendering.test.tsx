import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Goal, GoalEvent } from "./api.js";
import { EventTimelineList } from "./EventTimeline.js";
import { GoalDetailPanel } from "./GoalDetail.js";

test("goal detail shows latest available run provider and model", () => {
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={{ provider: "codex-cli", model: "gpt-5-codex" }}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /Run provider/);
  assert.match(html, /codex-cli/);
  assert.match(html, /Run model/);
  assert.match(html, /gpt-5-codex/);
});

test("timeline shows per-event provider and model metadata and tolerates missing metadata", () => {
  const html = renderToStaticMarkup(
    <EventTimelineList
      events={[
        event("goal.created", { goalId: "goal-1" }),
        event("run.started", { provider: "mock", model: "mock-v1" }),
        event("agent.message", { stepId: "step-1" }),
      ]}
    />,
  );

  assert.match(html, /run.started/);
  assert.match(html, /mock/);
  assert.match(html, /mock-v1/);
  assert.match(html, /goal.created/);
  assert.match(html, /agent.message/);
});

function goal(): Goal {
  return {
    id: "goal-1",
    title: "Show metadata",
    description: "Display the latest run metadata",
    priority: "normal",
    agentType: "general",
    status: "completed",
    createdAt: "2026-06-22T01:00:00.000Z",
    updatedAt: "2026-06-22T01:03:00.000Z",
    startedAt: "2026-06-22T01:01:00.000Z",
    completedAt: "2026-06-22T01:03:00.000Z",
  };
}

function event(type: string, data: Record<string, unknown>): GoalEvent {
  return {
    id: `${type}-${JSON.stringify(data)}`,
    goalId: "goal-1",
    runId: "run-1",
    stepId: null,
    type,
    message: `${type} message`,
    data,
    createdAt: "2026-06-22T01:02:00.000Z",
  };
}
