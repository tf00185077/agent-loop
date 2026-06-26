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

test("timeline renders observation event kinds with safe metadata and no raw payload", () => {
  const html = renderToStaticMarkup(
    <EventTimelineList
      events={[
        event("agent.command.started", {
          observationKind: "command.started",
          provider: "codex-cli",
          model: "gpt-5-codex",
          source: "jsonl",
          rawEventType: "item.started",
          agentRole: "main",
          agentId: "agent-1",
          taskId: "task-1",
          command: { label: "npm test", status: "started" },
          rawPayload: { token: "secret-raw-payload" },
        }),
        event("agent.heartbeat", {
          observationKind: "heartbeat",
          provider: "codex-cli",
          model: "gpt-5-codex",
          source: "future-source",
        }),
        event("agent.subtask.completed", {
          observationKind: "subtask.completed",
          provider: "codex-cli",
          model: "gpt-5-codex",
          agentId: "child-1",
          parentAgentId: "agent-1",
          taskId: "task-2",
          subtask: { title: "Update docs", status: "completed" },
        }),
      ]}
    />,
  );

  assert.match(html, /Command started/);
  assert.match(html, /Heartbeat/);
  assert.match(html, /Subtask completed/);
  assert.match(html, /codex-cli/);
  assert.match(html, /gpt-5-codex/);
  assert.match(html, /main/);
  assert.match(html, /agent-1/);
  assert.match(html, /task-1/);
  assert.match(html, /future-source/);
  assert.match(html, /Update docs/);
  assert.equal(html.includes("secret-raw-payload"), false);
  assert.equal(html.includes("rawPayload"), false);
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
