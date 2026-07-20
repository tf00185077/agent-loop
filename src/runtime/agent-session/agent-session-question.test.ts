import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeAdapter, AgentRuntimeEvent } from "../../domain/index.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createHandle, createManagerFixture, waitFor } from "./agent-session-test-harness.js";

/**
 * Supervisor-initiated escalation: a live supervisor asks its caller one
 * bounded question through the shared waiting_user contract
 * (specs/supervisor-goal-orchestration, specs/caller-escalation).
 */

function questionBlockEvent(
  input: { sessionId: string; goalId: string; runId: string },
  block: Record<string, unknown>,
  at: string,
): AgentRuntimeEvent {
  return {
    type: "progress",
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message: "Supervisor control block.",
    occurredAt: at,
    metadata: { delegationControlEvent: block },
  };
}

/**
 * Supervisor that emits the given control blocks on its first turn, records
 * every prompt, and ends each turn without a completion signal. An optional
 * `beforeFirstTurn` hook seeds durable state (e.g. an in-flight delegation)
 * against the freshly created supervisor session before its events pump.
 */
function questioningAdapter(
  prompts: string[],
  firstTurnBlocks: Record<string, unknown>[],
  beforeFirstTurn?: (sessionId: string) => void,
): AgentRuntimeAdapter {
  let turn = 0;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      prompts.push(input.prompt);
      turn += 1;
      const at = `2026-07-20T00:00:0${Math.min(turn, 9)}.000Z`;
      if (turn === 1) {
        beforeFirstTurn?.(input.sessionId);
        const events: AgentRuntimeEvent[] = firstTurnBlocks.map((block, index) =>
          questionBlockEvent(input, block, `2026-07-20T00:00:0${index + 1}.500Z`),
        );
        events.push({
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Turn ended.", occurredAt: at,
        });
        return createHandle(input.sessionId, events);
      }
      return createHandle(input.sessionId, [
        {
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Later turn ended.", occurredAt: at,
        },
      ]);
    },
  };
}

const QUESTION = { type: "managed_goal.request_input", question: "Should the export default to CSV or JSON?", context: ["Both are feasible."] };

test("a valid question parks the goal as a supervisor_question request", async () => {
  const fixture = createManagerFixture("question happy path");
  const prompts: string[] = [];
  const adapter = questioningAdapter(prompts, [QUESTION]);
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id);
  assert.equal(pending?.reasonCode, "supervisor_question");
  assert.equal(pending?.safeSummary, QUESTION.question);
  assert.deepEqual(pending?.payload.allowedDecisions, ["provide_guidance", "abandon"]);
  assert.equal(pending?.payload.budgetName, null);
  assert.equal(pending?.payload.budgetValue, null);
  assert.deepEqual(pending?.payload.evidence, ["Both are feasible."]);

  const event = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((e) => e.data.runtimeEventType === "supervisor.question");
  assert.equal(event?.type, "goal.input_requested");
  // The session ended after asking; the waiting_user guard suppressed a continuation.
  assert.ok(!fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((e) => e.data.runtimeEventType === "delegation.continuation_started"));
  assert.equal(prompts.length, 1, "no fresh continuation started while waiting");
  fixture.db.close();
});

test("answering a question resumes with the question and answer in the observation", async () => {
  const fixture = createManagerFixture("question answer resume");
  const prompts: string[] = [];
  const adapter = questioningAdapter(prompts, [QUESTION]);
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: pending.id,
    body: { decision: "provide_guidance", guidance: "Use CSV." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "resumed");
  assert.match(prompts[1]!, /Caller answered the supervisor's question\. Q: Should the export default to CSV or JSON\? A: Use CSV\./);
  // A question grants no budget.
  assert.equal(fixture.goalInputRequestRepo.sumAcceptedExtensions(fixture.goal.id, "supervisor_continuations"), 0);
  fixture.db.close();
});

test("abandoning a question blocks the goal", async () => {
  const fixture = createManagerFixture("question abandon");
  const prompts: string[] = [];
  const adapter = questioningAdapter(prompts, [QUESTION]);
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: pending.id, body: { decision: "abandon", reason: "not worth it" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "abandoned");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "blocked");
  fixture.db.close();
});

test("a question during an in-flight delegation is rejected", async () => {
  const fixture = createManagerFixture("question in-flight delegation");
  const prompts: string[] = [];
  // Seed a running delegation on the supervisor session before its events pump.
  const seedRunningDelegation = (sessionId: string) => {
    const childRun = fixture.runRepo.create({ goalId: fixture.goal.id, provider: "codex-local", model: "gpt-5-codex" });
    const child = fixture.agentSessionRepo.createSession({
      goalId: fixture.goal.id, runId: childRun.id, providerId: "codex-local", modelLabel: "gpt-5-codex",
      lifecycleState: "running",
      capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: false },
      parent: { sessionId },
    });
    const request = fixture.agentSessionRepo.createDelegationRequest({
      parentSessionId: sessionId, role: "worker", promptSummary: "Implement change.",
    });
    fixture.agentSessionRepo.acceptDelegationRequest(request.id);
    fixture.agentSessionRepo.startDelegationRequest(request.id, child.id);
  };
  const adapter = questioningAdapter(prompts, [QUESTION], seedRunningDelegation);
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((e) => e.data.runtimeEventType === "delegation.rejected"));

  const rejected = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((e) => e.data.runtimeEventType === "delegation.rejected")!;
  assert.match(String(rejected.data.safeReason), /child delegation is still in flight/i);
  assert.notEqual(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  assert.equal(fixture.goalInputRequestRepo.getPending(fixture.goal.id), null);
  fixture.db.close();
});

test("questions past the budget are rejected with autonomy guidance", async () => {
  const fixture = createManagerFixture("question budget exhausted");
  const prompts: string[] = [];
  // Pre-seed the goal's question budget as already exhausted (2 resolved
  // questions with a budget of 2).
  for (let i = 0; i < 2; i += 1) {
    const req = fixture.goalInputRequestRepo.createRequest({
      goalId: fixture.goal.id,
      reasonCode: "supervisor_question",
      safeSummary: `Prior question ${i}`,
      payload: { budgetName: null, budgetValue: null, evidence: [], remainingGaps: [], allowedDecisions: ["provide_guidance", "abandon"] },
    });
    fixture.goalInputRequestRepo.resolve(req.id, "accepted", { decision: "provide_guidance", guidance: "ok" });
  }
  const adapter = questioningAdapter(prompts, [QUESTION]);
  const manager = createAgentSessionManager({ ...fixture, maxSupervisorQuestions: 2 });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((e) => e.data.runtimeEventType === "delegation.rejected"));

  const rejected = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((e) => e.data.runtimeEventType === "delegation.rejected")!;
  assert.match(String(rejected.data.safeReason), /question budget \(2\) is exhausted/i);
  assert.match(String(rejected.data.safeReason), /decide autonomously/i);
  assert.notEqual(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  fixture.db.close();
});
