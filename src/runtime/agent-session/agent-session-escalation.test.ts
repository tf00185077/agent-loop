import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeAdapter } from "../../domain/index.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import {
  createHandle,
  createManagerFixture,
  recordingOpenSpecService,
  runScript,
  scriptedEpochAdapter,
  specFlow,
  waitFor,
} from "./agent-session-test-harness.js";

/**
 * Caller-escalation contract: response validation, effective budgets, and
 * resume-as-fresh-continuation (specs/caller-escalation).
 */

/** Supervisor adapter that always ends its turn without a completion signal,
 * recording every prompt it was started with. */
function completionlessAdapter(prompts: string[]): AgentRuntimeAdapter {
  let turn = 0;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      prompts.push(input.prompt);
      turn += 1;
      return createHandle(input.sessionId, [
        {
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Completionless turn ended.", occurredAt: `2026-07-20T00:00:0${Math.min(turn, 9)}.000Z`,
        },
      ]);
    },
  };
}

/** Drive a goal to continuation-exhaustion escalation with a tiny budget. */
async function escalatedFixture(title: string, maxSupervisorContinuations = 1) {
  const fixture = createManagerFixture(title);
  const prompts: string[] = [];
  const adapter = completionlessAdapter(prompts);
  const manager = createAgentSessionManager({ ...fixture, maxSupervisorContinuations });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const request = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;
  return { fixture, manager, adapter, prompts, request };
}

test("rejects a disallowed decision with a safe reason and leaves the request pending", async () => {
  const { fixture, manager, request } = await escalatedFixture("disallowed decision");
  // Forge a circuit-breaker-shaped restriction by answering with a decision
  // the request does not allow at all.
  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id, body: { decision: "grant_everything" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "invalid");
  assert.match(result.ok === false ? result.safeReason : "", /allowed decisions/i);
  assert.equal(fixture.goalInputRequestRepo.getPending(fixture.goal.id)?.id, request.id);
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  const rejectedEvent = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "goal.input_response_rejected");
  assert.ok(rejectedEvent, "rejection must be durable");
  fixture.db.close();
});

test("rejects out-of-range extensions and empty guidance", async () => {
  const { fixture, manager, request } = await escalatedFixture("invalid fields", 1);

  for (const body of [
    { decision: "extend_budget", extension: 0 },
    { decision: "extend_budget", extension: 2 }, // base budget is 1
    { decision: "extend_budget", extension: 1.5 },
    { decision: "provide_guidance", guidance: "   " },
  ]) {
    const result = await manager.respondToGoalInputRequest({
      goalId: fixture.goal.id, requestId: request.id, body,
    });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(body)}`);
    assert.equal(result.ok === false && result.code, "invalid");
  }
  assert.equal(fixture.goalInputRequestRepo.getPending(fixture.goal.id)?.id, request.id);
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  fixture.db.close();
});

test("second response meets the standing resolution without side effects", async () => {
  const { fixture, manager, adapter, request } = await escalatedFixture("standing resolution");
  const first = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id,
    body: { decision: "abandon", reason: "not worth more budget" },
  });
  assert.equal(first.ok, true);

  const second = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id,
    body: { decision: "extend_budget", extension: 1 },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.code, "conflict");
  assert.match(second.ok === false ? second.safeReason : "", /abandoned/);
  assert.equal(second.ok === false ? second.standing?.status : undefined, "abandoned");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "blocked");
  fixture.db.close();
});

test("abandon resolves the request and blocks the goal with a caller-attributed reason", async () => {
  const { fixture, manager, request } = await escalatedFixture("abandon path");
  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id,
    body: { decision: "abandon", reason: "scope no longer needed" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "abandoned");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "blocked");
  assert.equal(fixture.goalInputRequestRepo.getById(request.id)?.status, "abandoned");
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const blocked = events.find((event) => event.data.runtimeEventType === "goal.abandoned_by_caller");
  assert.equal(blocked?.type, "goal.blocked");
  assert.equal(blocked?.data.reason, "scope no longer needed");
  fixture.db.close();
});

test("accepted extension resumes the goal with the caller decision as an observation", async () => {
  const { fixture, manager, adapter, prompts, request } = await escalatedFixture("extension resume");
  const promptCountBeforeResume = prompts.length;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id,
    body: { decision: "extend_budget", extension: 1 },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "resumed");
  assert.equal(fixture.goalInputRequestRepo.getById(request.id)?.status, "accepted");

  // The resumed supervisor got a fresh continuation prompt carrying the grant.
  assert.ok(prompts.length > promptCountBeforeResume, "a fresh supervisor session must start");
  assert.match(prompts[promptCountBeforeResume]!, /Caller input: granted additional supervisor continuations/);
  assert.match(prompts[promptCountBeforeResume]!, /effective budget is now 2/);

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const ordered = events
    .filter((event) => ["goal.input_requested", "goal.input_response"].includes(event.type)
      || event.data.runtimeEventType === "escalation.resumed")
    .map((event) => event.data.runtimeEventType);
  assert.deepEqual(ordered.slice(0, 3), [
    "supervisor.continuations_exhausted",
    "goal.input_response_accepted",
    "escalation.resumed",
  ]);

  // The completionless adapter exhausts the extended bound again: exactly one
  // more continuation ran under base+grant before the second escalation.
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const requests = fixture.goalInputRequestRepo.listForGoal(fixture.goal.id);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.payload.budgetValue, 2, "second escalation reports the extended effective budget");
  fixture.db.close();
});

test("accepted guidance resumes with the guidance text and implies a minimal grant", async () => {
  const { fixture, manager, adapter, prompts, request } = await escalatedFixture("guidance resume");
  const promptCountBeforeResume = prompts.length;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id,
    body: { decision: "provide_guidance", guidance: "Ship the smallest passing slice first." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });

  assert.equal(result.ok, true);
  assert.match(prompts[promptCountBeforeResume]!, /Caller input: guidance for continuing — Ship the smallest passing slice first\./);
  // Implicit +1 grant lets the loop act instead of instantly re-escalating.
  assert.equal(fixture.goalInputRequestRepo.sumAcceptedExtensions(fixture.goal.id, "supervisor_continuations"), 1);
  fixture.db.close();
});

test("accepted response without a runtime defers resume as a visible interrupted state", async () => {
  const { fixture, manager, request } = await escalatedFixture("deferred resume");
  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: request.id,
    body: { decision: "extend_budget", extension: 1 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "resume_deferred");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "interrupted");
  const deferred = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "escalation.resume_deferred");
  assert.ok(deferred, "deferred resume must be durable");
  fixture.db.close();
});

test("an accepted epoch grant admits the next epoch instead of re-escalating", async () => {
  const fixture = createManagerFixture("epoch grant admits next epoch");
  // A previously accepted extend_budget grant (durable) raises the effective
  // planning-epoch budget from 1 to 2.
  const prior = fixture.goalInputRequestRepo.createRequest({
    goalId: fixture.goal.id,
    reasonCode: "epoch_budget_exhausted",
    safeSummary: "Planning-epoch budget exhausted.",
    payload: {
      budgetName: "planning_epochs", budgetValue: 1, evidence: [], remainingGaps: [],
      allowedDecisions: ["extend_budget", "provide_guidance", "abandon"],
    },
  });
  fixture.goalInputRequestRepo.resolve(prior.id, "accepted", { decision: "extend_budget", extension: 1 });

  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 2, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "Only batch." }],
          },
          "2026-07-20T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-20T00:00:0${2 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: [{ refs: ["new:more-work"], summary: "More work is needed." }],
            nextEpochRationale: "Open another epoch.",
          },
          "2026-07-20T00:00:04.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
    maxPlanningEpochs: 1,
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.runtimeEventType === "supervisor.reassessment"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(
    !events.some((event) => event.data.runtimeEventType === "supervisor.epoch_budget_exhausted"),
    "the granted budget must admit the next epoch instead of escalating",
  );
  assert.notEqual(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  fixture.db.close();
});

test("responding to an unknown request or wrong goal is not found", async () => {
  const { fixture, manager, request } = await escalatedFixture("unknown request");
  const unknown = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: "no-such-request", body: { decision: "abandon" },
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.code, "not_found");

  const otherGoal = fixture.goalRepo.create({ title: "other", description: "other" });
  const wrongGoal = await manager.respondToGoalInputRequest({
    goalId: otherGoal.id, requestId: request.id, body: { decision: "abandon" },
  });
  assert.equal(wrongGoal.ok, false);
  assert.equal(wrongGoal.ok === false && wrongGoal.code, "not_found");
  fixture.db.close();
});
