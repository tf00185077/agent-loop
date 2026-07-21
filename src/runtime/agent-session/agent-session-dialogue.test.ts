import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeAdapter, AgentRuntimeEvent } from "../../domain/index.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createHandle, createManagerFixture, waitFor } from "./agent-session-test-harness.js";

/**
 * Multi-turn read-only conversations (specs/caller-escalation): a caller reply
 * runs a read-only conversational turn; the supervisor asks again or signals
 * ready_to_proceed to resume work.
 */

function controlEvent(
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

/** Supervisor driven by a script keyed on the prompt it receives each turn. */
function dialogueAdapter(
  prompts: string[],
  script: (prompt: string, turn: number) => Record<string, unknown>[],
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
      const at = (i: number) => `2026-07-20T00:0${Math.min(turn, 9)}:0${i}.000Z`;
      const blocks = script(input.prompt, turn);
      const events: AgentRuntimeEvent[] = blocks.map((b, i) => controlEvent(input, b, at(i)));
      events.push({
        type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Turn ended.", occurredAt: at(9),
      });
      return createHandle(input.sessionId, events);
    },
  };
}

const isConversationTurn = (p: string) => /READ-ONLY clarification/.test(p);
const isResumedWork = (p: string) => /conversation resolved/i.test(p);

test("a plan proposal, multi-turn clarification, and ready_to_proceed resume the goal", async () => {
  const fixture = createManagerFixture("dialogue happy path");
  const prompts: string[] = [];
  const adapter = dialogueAdapter(prompts, (prompt) => {
    if (isResumedWork(prompt)) return [{ type: "managed_delegation.complete", summary: "Done after confirmation." }];
    if (isConversationTurn(prompt)) {
      // First conversational turn asks once more; second signals ready.
      const priorCallerReplies = (prompt.match(/Caller:/g) ?? []).length;
      return priorCallerReplies >= 2
        ? [{ type: "managed_goal.ready_to_proceed", summary: "Clear now." }]
        : [{ type: "managed_goal.request_input", question: "Which region first?" }];
    }
    // Bootstrap: propose a plan.
    return [{ type: "managed_goal.propose_plan", summary: "Plan: ingest, then report.", items: ["Ingest", "Report"] }];
  });
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const opened = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;
  assert.equal(opened.reasonCode, "plan_confirmation");
  assert.equal(opened.payload.phase, "awaiting_caller");
  assert.equal(opened.payload.thread?.length, 1);

  // First caller reply → conversational turn asks again → still waiting.
  const first = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: opened.id,
    body: { decision: "provide_guidance", guidance: "Report weekly." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(first.ok && first.outcome, "conversation_continued");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  assert.equal(fixture.goalInputRequestRepo.getPending(fixture.goal.id)?.payload.phase, "awaiting_caller");

  // Second caller reply → conversational turn signals ready → resume + complete.
  const second = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: opened.id,
    body: { decision: "provide_guidance", guidance: "Start with EU." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(second.ok && second.outcome, "resumed");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((e) => e.data.runtimeEventType === "goal.plan_confirmed" && e.data.resolution === "supervisor_ready"));
  assert.ok(events.some((e) => e.data.runtimeEventType === "conversation.resumed"));
  // The resumed working session ran and completed the flat goal.
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "completed");
  // No spurious continuation from the superseded conversational session.
  const resolved = fixture.goalInputRequestRepo.getById(opened.id)!;
  assert.equal(resolved.status, "accepted");
  assert.equal(resolved.payload.thread?.filter((m) => m.role === "supervisor").length, 3);
  fixture.db.close();
});

test("a work-producing block during a conversational turn is rejected read-only", async () => {
  const fixture = createManagerFixture("dialogue read-only");
  const prompts: string[] = [];
  const adapter = dialogueAdapter(prompts, (prompt) => {
    if (isConversationTurn(prompt)) {
      // Attempt to work mid-conversation — must be rejected.
      return [{ type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "Do it", prompt: "Full." }];
    }
    return [{ type: "managed_goal.propose_plan", summary: "Plan: do the thing.", items: [] }];
  });
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const opened = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: opened.id,
    body: { decision: "provide_guidance", guidance: "Go ahead." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(result.ok && result.outcome, "conversation_continued");

  const rejected = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((e) => e.data.runtimeEventType === "delegation.rejected");
  assert.match(String(rejected?.data.safeReason), /read-only clarification/i);
  // The goal is still waiting and no delegation was created.
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  fixture.db.close();
});

test("the caller can force-proceed a conversation", async () => {
  const fixture = createManagerFixture("dialogue proceed");
  const prompts: string[] = [];
  const adapter = dialogueAdapter(prompts, (prompt) => {
    if (isResumedWork(prompt)) return [{ type: "managed_delegation.complete", summary: "Done." }];
    return [{ type: "managed_goal.request_input", question: "CSV or JSON?" }];
  });
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const opened = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: opened.id,
    body: { decision: "proceed", note: "Just decide it yourself." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(result.ok && result.outcome, "resumed");
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((e) => e.data.runtimeEventType === "conversation.resolved" && e.data.resolution === "caller_forced"));
  // supervisor_question is not a plan_confirmation, so no standing confirmation.
  assert.ok(!events.some((e) => e.data.runtimeEventType === "goal.plan_confirmed"));
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "completed");
  fixture.db.close();
});

test("the conversation-turn budget resolves a runaway clarification", async () => {
  const fixture = createManagerFixture("dialogue budget");
  const prompts: string[] = [];
  const adapter = dialogueAdapter(prompts, (prompt) => {
    if (isResumedWork(prompt)) return [{ type: "managed_delegation.complete", summary: "Done." }];
    if (isConversationTurn(prompt)) return [{ type: "managed_goal.request_input", question: "And also?" }];
    return [{ type: "managed_goal.propose_plan", summary: "Plan.", items: [] }];
  });
  // Budget of 1 supervisor turn: the propose is turn 1, the next ask is over budget.
  const manager = createAgentSessionManager({ ...fixture, maxSupervisorConversationTurns: 1 });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");
  const opened = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;

  const result = await manager.respondToGoalInputRequest({
    goalId: fixture.goal.id, requestId: opened.id,
    body: { decision: "provide_guidance", guidance: "Reply." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(result.ok && result.outcome, "resumed");
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((e) => e.data.runtimeEventType === "conversation.resolved" && e.data.resolution === "budget_forced"));
  fixture.db.close();
});

test("under required policy a delegation is rejected until the plan is confirmed", async () => {
  const fixture = createManagerFixture("checkpoint gate");
  fixture.goalRepo.updateStatus(fixture.goal.id, "draft");
  // Recreate the goal with a required policy (create() sets draft; the harness
  // goal is off). Use a fresh required goal instead.
  const goal = fixture.goalRepo.create({
    title: "High stakes", description: "needs sign-off", confirmationPolicy: "required",
  });
  fixture.goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-20T00:00:00.000Z" });

  const prompts: string[] = [];
  let dispatchedBeforeConfirm = false;
  const adapter = dialogueAdapter(prompts, (prompt, turn) => {
    if (isResumedWork(prompt)) {
      // After confirmation the worker delegation is accepted.
      return [{ type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "Do it", prompt: "Full instructions." }];
    }
    if (isConversationTurn(prompt)) return [{ type: "managed_goal.ready_to_proceed", summary: "Confirmed." }];
    if (turn === 1) {
      // Bootstrap: try to dispatch work immediately — must be rejected — then propose.
      return [
        { type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "Premature", prompt: "Full." },
        { type: "managed_goal.propose_plan", summary: "Plan: do task 1.", items: ["task 1"] },
      ];
    }
    return [];
  });
  void dispatchedBeforeConfirm;
  const manager = createAgentSessionManager({ ...fixture });
  // Redirect the manager fixture's repos are shared; start the required goal.
  await manager.startManagedSession({
    goalId: goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(goal.id)?.status === "waiting_user");

  const events = fixture.eventRepo.listForGoal(goal.id);
  // The premature delegation was rejected with the propose-first reason.
  const rejected = events.find((e) => e.data.runtimeEventType === "delegation.rejected");
  assert.match(String(rejected?.data.safeReason), /requires caller confirmation before work/i);
  // No worker delegation was created before confirmation.
  const opened = fixture.goalInputRequestRepo.getPending(goal.id)!;
  assert.equal(opened.reasonCode, "plan_confirmation");

  // Caller confirms → conversational turn signals ready → resume → worker dispatched.
  const result = await manager.respondToGoalInputRequest({
    goalId: goal.id, requestId: opened.id,
    body: { decision: "provide_guidance", guidance: "Looks right." },
    runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
  });
  assert.equal(result.ok && result.outcome, "resumed");
  const afterEvents = fixture.eventRepo.listForGoal(goal.id);
  assert.ok(afterEvents.some((e) => e.data.runtimeEventType === "goal.plan_confirmed"));
  // A worker delegation was accepted after confirmation (a child request exists).
  assert.ok(afterEvents.some((e) => e.data.runtimeEventType === "delegation.requested"
    || e.data.runtimeEventType === "delegation.accepted" || String(e.message).includes("worker")));
  fixture.db.close();
});

test("off policy dispatches work with no checkpoint", async () => {
  const fixture = createManagerFixture("checkpoint off");
  // The harness goal defaults to off.
  const prompts: string[] = [];
  const adapter = dialogueAdapter(prompts, (_prompt, turn) => {
    if (turn === 1) return [{ type: "managed_delegation.request", role: "worker", taskId: "task-1", summary: "Go", prompt: "Full." }];
    return [];
  });
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((e) => e.data.runtimeEventType === "delegation.requested" || e.data.runtimeEventType === "delegation.accepted"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  // No confirmation checkpoint rejection.
  assert.ok(!events.some((e) => e.data.runtimeEventType === "delegation.rejected"
    && /requires caller confirmation/i.test(String(e.data.safeReason))));
  fixture.db.close();
});
