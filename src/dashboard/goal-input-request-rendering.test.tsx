import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Goal, GoalInputRequestView } from "./api.js";
import { GoalDetailPanel, GoalInputRequestPanel } from "./GoalDetail.js";

function goal(status: Goal["status"] = "waiting_user"): Goal {
  return {
    id: "goal-1",
    title: "Escalated goal",
    description: "Needs caller input",
    status,
    priority: "medium",
    agentType: "general",
    createdAt: "2026-07-20T00:00:00.000Z",
    startedAt: "2026-07-20T00:00:01.000Z",
    completedAt: null,
    updatedAt: "2026-07-20T00:00:02.000Z",
  } as Goal;
}

function inputRequest(overrides: Partial<GoalInputRequestView["payload"]> = {}): GoalInputRequestView {
  return {
    id: "request-1",
    goalId: "goal-1",
    reasonCode: "epoch_budget_exhausted",
    safeSummary: "Goal reached its planning-epoch budget (5) with gaps remaining.",
    payload: {
      budgetName: "planning_epochs",
      budgetValue: 5,
      evidence: ["All epoch-5 changes archived."],
      remainingGaps: [{ refs: ["new:reporting"], summary: "Reporting scope is missing" }],
      allowedDecisions: ["extend_budget", "provide_guidance", "abandon"],
      ...overrides,
    },
    status: "pending",
    createdAt: "2026-07-20T00:00:03.000Z",
    resolvedAt: null,
  };
}

test("goal detail renders the waiting_user badge and the pending input request panel", () => {
  const html = renderToStaticMarkup(
    <GoalDetailPanel
      goal={goal()}
      latestMetadata={null}
      inputRequest={inputRequest()}
      starting={false}
      onStart={() => undefined}
    />,
  );

  assert.match(html, /waiting_user/);
  assert.match(html, /Caller input needed/);
  assert.match(html, /Planning-epoch budget exhausted/);
  assert.match(html, /planning-epoch budget \(5\)/);
  assert.match(html, /Reporting scope is missing/);
  assert.match(html, /new:reporting/);
  assert.match(html, /Extend budget/);
  assert.match(html, /Send guidance/);
  assert.match(html, /Abandon goal/);
});

test("the panel offers exactly the allowed decisions", () => {
  const html = renderToStaticMarkup(
    <GoalInputRequestPanel
      request={{
        ...inputRequest({ allowedDecisions: ["provide_guidance", "abandon"] }),
        reasonCode: "reassessment_circuit_breaker",
      }}
      notice={null}
    />,
  );

  assert.match(html, /Reassessment loop is not converging/);
  assert.doesNotMatch(html, /Extend budget/);
  assert.match(html, /Send guidance/);
  assert.match(html, /Abandon goal/);
});

test("a supervisor question renders its text with guidance and abandon only", () => {
  const html = renderToStaticMarkup(
    <GoalInputRequestPanel
      request={{
        ...inputRequest({
          budgetName: null,
          budgetValue: null,
          evidence: ["Both formats are feasible."],
          remainingGaps: [],
          allowedDecisions: ["provide_guidance", "abandon"],
        }),
        reasonCode: "supervisor_question",
        safeSummary: "Should the export default to CSV or JSON?",
      }}
      notice={null}
    />,
  );

  assert.match(html, /The supervisor is asking a question/);
  assert.match(html, /Should the export default to CSV or JSON\?/);
  assert.doesNotMatch(html, /Extend budget/);
  // A supervisor question is a conversation, so the reply affordance is labelled accordingly.
  assert.match(html, /Send reply/);
  assert.match(html, /Abandon goal/);
});

test("a standing-resolution notice renders without a pending request", () => {
  const html = renderToStaticMarkup(
    <GoalInputRequestPanel request={null} notice="Already resolved: accepted." />,
  );
  assert.match(html, /Already resolved: accepted\./);
  assert.doesNotMatch(html, /Abandon goal/);
});

test("a plan-confirmation conversation renders the thread with a reply box and proceed", () => {
  const html = renderToStaticMarkup(
    <GoalInputRequestPanel
      request={{
        ...inputRequest({
          budgetName: null,
          budgetValue: null,
          evidence: [],
          remainingGaps: [],
          allowedDecisions: ["provide_guidance", "proceed", "abandon"],
          thread: [
            { role: "supervisor", text: "Plan: ingest then report.", at: "2026-07-20T00:00:00.000Z" },
            { role: "caller", text: "Report weekly please.", at: "2026-07-20T00:01:00.000Z" },
          ],
          phase: "awaiting_caller",
        }),
        reasonCode: "plan_confirmation",
        safeSummary: "Plan: ingest then report.",
      }}
      notice={null}
    />,
  );

  assert.match(html, /The supervisor wants you to confirm its plan/);
  assert.match(html, /Plan: ingest then report\./);
  assert.match(html, /Report weekly please\./);
  assert.match(html, /Supervisor/);
  assert.match(html, /Send reply/);
  assert.match(html, /Proceed now/);
  assert.match(html, /Abandon goal/);
  assert.doesNotMatch(html, /Extend budget/);
});

test("an awaiting-supervisor phase shows the supervisor is responding", () => {
  const html = renderToStaticMarkup(
    <GoalInputRequestPanel
      request={{
        ...inputRequest({
          budgetName: null, budgetValue: null, evidence: [], remainingGaps: [],
          allowedDecisions: ["provide_guidance", "proceed", "abandon"],
          thread: [{ role: "supervisor", text: "Q?", at: "t0" }, { role: "caller", text: "A.", at: "t1" }],
          phase: "awaiting_supervisor",
        }),
        reasonCode: "supervisor_question",
      }}
      notice={null}
    />,
  );
  assert.match(html, /supervisor is responding/i);
});

test("goal detail shows the goal's workspace and the server default", () => {
  const scoped = renderToStaticMarkup(
    <GoalDetailPanel goal={{ ...goal("running"), workspace: "C:\Users\dev\scratch-repo" }} latestMetadata={null} starting={false} onStart={() => undefined} />,
  );
  assert.match(scoped, /Workspace/);
  assert.match(scoped, /scratch-repo/);

  const defaulted = renderToStaticMarkup(
    <GoalDetailPanel goal={{ ...goal("running"), workspace: null }} latestMetadata={null} starting={false} onStart={() => undefined} />,
  );
  assert.match(defaulted, /server default/);
});
