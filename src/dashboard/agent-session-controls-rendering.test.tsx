import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentSessionSnapshot, Goal } from "./api.js";
import { GoalDetailPanel } from "./GoalDetail.js";

test("goal detail renders managed session state approvals cancellation and unsupported controls", () => {
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={{ provider: "codex-local", model: "gpt-5-codex" }}
      agentSessionSnapshot={sessionSnapshot()}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /Managed session/);
  assert.match(html, /waiting_approval/);
  assert.match(html, /codex-local/);
  assert.match(html, /gpt-5-codex/);
  assert.match(html, /Run tests/);
  assert.match(html, /pending/);
  assert.match(html, /Already approved/);
  assert.match(html, /approved/);
  assert.match(html, /Cancel session/);
  assert.match(html, /Codex exec mode cannot resume approvals/);
});

test("goal detail tolerates historical goals without managed session metadata", () => {
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={null}
      agentSessionSnapshot={null}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /Dashboard session controls/);
  assert.equal(html.includes("Managed session"), false);
  assert.equal(html.includes("Cancel session"), false);
});

test("goal detail renders approval actions only for pending approvals when approval is supported", () => {
  const snapshot = sessionSnapshot();
  snapshot.session!.capabilities.approval = true;
  snapshot.session!.capabilities.unsupportedReasons = {};
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={{ provider: "codex-local", model: "gpt-5-codex" }}
      agentSessionSnapshot={snapshot}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /Approve/);
  assert.match(html, /Reject/);
  assert.equal((html.match(/Approve/g) ?? []).length, 1);
  assert.equal((html.match(/Reject/g) ?? []).length, 1);
});

test("goal detail hides cancel control when cancellation is unsupported", () => {
  const snapshot = sessionSnapshot();
  snapshot.session!.capabilities.cancellation = false;
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={{ provider: "codex-local", model: "gpt-5-codex" }}
      agentSessionSnapshot={snapshot}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.equal(html.includes("Cancel session"), false);
});

function goal(): Goal {
  return {
    id: "goal-1",
    title: "Dashboard session controls",
    description: "Display runtime controls.",
    priority: "normal",
    agentType: "general",
    status: "running",
    createdAt: "2026-06-22T01:00:00.000Z",
    updatedAt: "2026-06-22T01:03:00.000Z",
    startedAt: "2026-06-22T01:01:00.000Z",
    completedAt: null,
  };
}

function sessionSnapshot(): AgentSessionSnapshot {
  return {
    session: {
      id: "session-1",
      goalId: "goal-1",
      runId: "run-1",
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      lifecycleState: "waiting_approval",
      capabilities: {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: false,
        unsupportedReasons: {
          approval: "Codex exec mode cannot resume approvals.",
        },
      },
      createdAt: "2026-06-22T01:01:00.000Z",
      lastActivityAt: "2026-06-22T01:02:00.000Z",
    },
    approvals: [
      {
        id: "approval-1",
        sessionId: "session-1",
        commandId: "command-1",
        status: "pending",
        safeSummary: "Run tests",
        command: null,
        createdAt: "2026-06-22T01:02:00.000Z",
        resolvedAt: null,
      },
      {
        id: "approval-2",
        sessionId: "session-1",
        commandId: null,
        status: "approved",
        safeSummary: "Already approved",
        command: null,
        createdAt: "2026-06-22T01:01:30.000Z",
        resolvedAt: "2026-06-22T01:01:40.000Z",
      },
    ],
    childSessionRequests: [],
  };
}
