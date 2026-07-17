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
  assert.match(html, /Agent live status/);
  assert.match(html, /Waiting · Approval/);
  assert.match(html, /Run tests/);
  assert.match(html, /session-1/);
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

test("goal detail renders the planning epoch board with statuses, rationale, and gaps", () => {
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={{ provider: "codex-local", model: "gpt-5-codex" }}
      agentSessionSnapshot={{
        ...sessionSnapshot(),
        planningEpochs: [
          {
            sequence: 1,
            rationale: null,
            status: "gaps_found",
            changes: [
              { id: "change-core", title: "Core loop", status: "archived" },
              { id: "change-modes", title: "Modes", status: "archived" },
            ],
            reassessment: {
              goalSatisfied: false,
              evidence: ["core delivered"],
              remainingGaps: [{ refs: ["new:verification"], summary: "verification missing" }],
              nextEpochRationale: "integration surfaced a gap",
            },
          },
          {
            sequence: 2,
            rationale: "integration surfaced a gap",
            status: "executing",
            changes: [{ id: "change-verify", title: "Verification", status: "specifying" }],
            reassessment: null,
          },
        ],
      }}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /Planning epochs/);
  assert.match(html, /Epoch 1 — gaps found — next epoch/);
  assert.match(html, /Epoch 2 — executing/);
  assert.match(html, /Why this epoch: integration surfaced a gap/);
  assert.match(html, /change-core · archived/);
  assert.match(html, /change-verify · specifying/);
  assert.match(html, /Reassessment: gaps remain/);
  assert.match(html, /verification missing/);
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

test("goal detail renders managed delegation tree state and outcomes", () => {
  const snapshot = sessionSnapshot();
  snapshot.session!.lifecycleState = "waiting_child";
  snapshot.delegationRequests = [
    {
      id: "delegation-1",
      parentSessionId: "session-1",
      childSessionId: "session-child",
      role: "worker",
      status: "failed",
      promptSummary: "Run focused tests.",
      resultSummary: {
        kind: "failure",
        safeSummary: "Worker could not complete focused tests.",
      },
      detachedReason: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:01.000Z",
      acceptedAt: "2026-07-03T00:00:00.000Z",
      startedAt: "2026-07-03T00:00:01.000Z",
      completedAt: "2026-07-03T00:00:02.000Z",
    },
  ];
  snapshot.sessions = [
    snapshot.session!,
    {
      id: "session-child",
      goalId: "goal-1",
      runId: "run-1",
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      lifecycleState: "completed",
      capabilities: {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: false,
      },
      parent: { sessionId: "session-1" },
      worktree: {
        label: "child-session",
        path: "C:\\worktrees\\child-session",
      },
      createdAt: "2026-07-03T00:00:00.000Z",
      lastActivityAt: "2026-07-03T00:00:02.000Z",
    },
  ];
  snapshot.mergeOutcomes = [
    {
      delegationRequestId: "delegation-1",
      childSessionId: "session-child",
      outcome: "test_failed_reverted",
      diffSummary: "1 file changed.",
      safeSummary: "Fixed review-merge test failed; workspace revert verified.",
      fixedTest: { command: "npm test", exitCode: 1, outputSummary: "failed tests" },
      revertEvidence: { verified: true, summary: "Workspace reverted to pre-merge checkpoint." },
    },
  ];

  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={{ provider: "codex-local", model: "gpt-5-codex" }}
      agentSessionSnapshot={snapshot}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /waiting_child/);
  assert.match(html, /worker/);
  assert.match(html, /failed/);
  assert.match(html, /session-child/);
  assert.match(html, /worktree child-session/);
  assert.match(html, /Worker could not complete focused tests/);
  assert.match(html, /merge test_failed_reverted/);
  assert.match(html, /1 file changed/);
  assert.match(html, /npm test: exit 1/);
  assert.match(html, /Workspace reverted to pre-merge checkpoint/);
});

test("goal detail renders durable integration recovery state", () => {
  const snapshot = sessionSnapshot();
  snapshot.managedTasks = [{
    id: "task-1", title: "Resolve conflict", status: "awaiting_delivery",
    criteria: [{ id: "A1", text: "Pass", outcome: "PASS" }],
    lastJudgeVerdict: "accepted", lastDeliveryStatus: "conflict",
    lastIntegrationStatus: "awaiting_review", integrationAttemptId: "integration-1",
    resolvedCandidateCommitSha: "candidate-2", lastSafeSummary: "Resolved candidate ready.",
  }];
  const html = renderToStaticMarkup(
    <GoalDetailPanel goal={goal()} latestMetadata={null} agentSessionSnapshot={snapshot}
      starting={false} onStart={() => undefined} />,
  );
  assert.match(html, /Managed task state/);
  assert.match(html, /integration awaiting_review \(integration-1\)/);
  assert.match(html, /resolved candidate candidate-2/);
});

test("live status panel renders every pipeline family and tolerates partial or future metadata", () => {
  const cases = [
    ["waiting", "worker", "Waiting · Worker"],
    ["waiting", "judge", "Waiting · Judge"],
    ["waiting", "integrator", "Waiting · Integrator"],
    ["waiting", "rejudge", "Waiting · Rejudge"],
    ["running", "delivery", "Running · Delivery"],
    ["stalled", "validation", "Stalled · Validation"],
    ["completed", "none", "Completed · None"],
  ] as const;
  for (const [state, phase, label] of cases) {
    const snapshot = sessionSnapshot();
    snapshot.liveStatus = { ...snapshot.liveStatus!, state, phase, summary: `${phase} summary` };
    const html = renderToStaticMarkup(
      <GoalDetailPanel goal={goal()} latestMetadata={null} agentSessionSnapshot={snapshot}
        starting={false} onStart={() => undefined} />,
    );
    assert.ok(html.indexOf("Agent live status") < html.indexOf("Managed session"));
    assert.ok(html.includes(label));
    assert.ok(html.includes(`${phase} summary`));
  }

  const partial = sessionSnapshot();
  partial.liveStatus = {
    ...partial.liveStatus!, state: "unknown", phase: "none", provider: null, model: null,
    sessionId: null, lastActivityAt: null,
  };
  const partialHtml = renderToStaticMarkup(
    <GoalDetailPanel goal={goal()} latestMetadata={null} agentSessionSnapshot={partial}
      starting={false} onStart={() => undefined} />,
  );
  assert.match(partialHtml, /Unknown · None/);

  const future = sessionSnapshot();
  future.liveStatus = { ...future.liveStatus!, state: "unknown", phase: "future_phase" as never };
  const futureHtml = renderToStaticMarkup(
    <GoalDetailPanel goal={goal()} latestMetadata={null} agentSessionSnapshot={future}
      starting={false} onStart={() => undefined} />,
  );
  assert.match(futureHtml, /Unknown · Future phase/);
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
    liveStatus: {
      state: "waiting", phase: "approval", summary: "Run tests",
      lastActivityAt: "2026-06-22T01:02:00.000Z", provider: "codex-local", model: "gpt-5-codex",
      sessionId: "session-1", parentSessionId: null, delegationRequestId: null, role: null, taskId: null,
      integrationAttemptId: null, resolvedCandidateCommitSha: null,
    },
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
    delegationRequests: [],
  };
}
