import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentSessionHandle,
} from "../../domain/index.js";
import { openDatabase } from "../../persistence/database.js";
import type { EventBus } from "../../persistence/event-bus.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";

test("starts a managed session consumes adapter events and updates durable session state", async () => {
  const publishedEventIds: string[] = [];
  const eventBus: EventBus = {
    publish(event) {
      publishedEventIds.push(event.id);
    },
    subscribe() {
      return () => undefined;
    },
  };
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-manager-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db, { eventBus });
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Managed runtime goal",
    description: "Exercise session manager.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const events: AgentRuntimeEvent[] = [
    {
      type: "progress",
      sessionId: "session-from-manager",
      goalId: goal.id,
      runId: "run-from-manager",
      message: "Adapter started work",
      occurredAt: "2026-06-26T00:00:01.000Z",
      metadata: { providerId: "codex-local", modelLabel: "gpt-5-codex" },
    },
    {
      type: "approval.requested",
      sessionId: "session-from-manager",
      goalId: goal.id,
      runId: "run-from-manager",
      message: "Approval requested",
      occurredAt: "2026-06-26T00:00:02.000Z",
      metadata: { approvalRequestId: "approval-1", commandId: "command-1" },
    },
    {
      type: "session.completed",
      sessionId: "session-from-manager",
      goalId: goal.id,
      runId: "run-from-manager",
      message: "Adapter completed",
      occurredAt: "2026-06-26T00:00:03.000Z",
      metadata: { providerId: "codex-local", modelLabel: "gpt-5-codex" },
    },
  ];
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: true,
        cancellation: true,
        resume: false,
        childSessions: false,
      };
    },
    async startSession(input) {
      assert.equal(input.goalId, goal.id);
      return createHandle(input.sessionId, events);
    },
  };
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Do the work",
    adapter,
  });

  const session = agentSessionRepo.getSession(result.session.id);
  assert.equal(session?.lifecycleState, "completed");
  assert.equal(session?.capabilities.approval, true);
  const durableEvents = eventRepo.listForGoal(goal.id);
  assert.deepEqual(
    durableEvents.map((event) => event.type),
    ["run.started", "agent.progress", "agent.progress", "run.completed", "goal.completed"],
  );
  assert.deepEqual(publishedEventIds, durableEvents.map((event) => event.id));
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  db.close();
});

test("recovers orphaned non-terminal sessions as stalled visible state", () => {
  const publishedEventIds: string[] = [];
  const eventBus: EventBus = {
    publish(event) {
      publishedEventIds.push(event.id);
    },
    subscribe() {
      return () => undefined;
    },
  };
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-recovery-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db, { eventBus });
  const agentSessionRepo = createAgentSessionRepository(db, {
    now: fixedClock([
      "2026-06-26T00:00:00.000Z",
      "2026-06-26T00:00:01.000Z",
      "2026-06-26T00:05:00.000Z",
      "2026-06-26T00:05:01.000Z",
    ]),
  });
  const goal = goalRepo.create({
    title: "Recover orphaned session",
    description: "Backend restarted while adapter was running.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const run = runRepo.create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const running = agentSessionRepo.createSession({
    goalId: goal.id,
    runId: run.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "running",
    capabilities: {
      eventStreaming: true,
      approval: true,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
  });
  const terminalRun = runRepo.create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const completed = agentSessionRepo.createSession({
    goalId: goal.id,
    runId: terminalRun.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "completed",
    capabilities: {
      eventStreaming: true,
      approval: true,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
  });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });

  const recovered = manager.recoverOrphanedSessions();

  assert.deepEqual(recovered.map((session) => session.id), [running.id]);
  assert.equal(agentSessionRepo.getSession(running.id)?.lifecycleState, "stalled");
  assert.equal(agentSessionRepo.getSession(completed.id)?.lifecycleState, "completed");
  const recoveryEvent = eventRepo
    .listForGoal(goal.id)
    .find((event) => event.type === "error" && event.data.sessionId === running.id);
  assert.ok(recoveryEvent);
  assert.match(recoveryEvent.message, /lost adapter control/i);
  assert.equal(runRepo.getById(run.id)?.status, "failed");
  assert.equal(goalRepo.getById(goal.id)?.status, "failed");
  assert.deepEqual(publishedEventIds, eventRepo.listForGoal(goal.id).map((event) => event.id));

  db.close();
});

test("forwards approve reject and cancel controls to the active adapter exactly once", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-controls-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Control active adapter",
    description: "Adapter controls should be idempotent.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const controls: string[] = [];
  let startedSessionId = "";
  let releaseEvents!: () => void;
  const eventsReleased = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: true,
        cancellation: true,
        resume: false,
        childSessions: false,
      };
    },
    async startSession(input) {
      startedSessionId = input.sessionId;
      return {
        sessionId: input.sessionId,
        capabilities: {
          eventStreaming: true,
          approval: true,
          cancellation: true,
          resume: false,
          childSessions: false,
        },
        async *events() {
          yield {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Waiting for controls",
            occurredAt: "2026-06-26T00:00:01.000Z",
          } satisfies AgentRuntimeEvent;
          await eventsReleased;
          yield {
            type: "session.cancelled",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Cancelled",
            occurredAt: "2026-06-26T00:00:02.000Z",
          } satisfies AgentRuntimeEvent;
        },
        async send() {},
        async approve(requestId) {
          controls.push(`approve:${requestId}`);
        },
        async reject(requestId) {
          controls.push(`reject:${requestId}`);
        },
        async cancel() {
          controls.push("cancel");
          releaseEvents();
        },
      };
    },
  };
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });

  const running = manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Wait for controls",
    adapter,
  });
  await waitFor(() => startedSessionId.length > 0);

  assert.equal(await manager.approve(startedSessionId, "approval-1"), true);
  assert.equal(await manager.approve(startedSessionId, "approval-1"), false);
  assert.equal(await manager.reject(startedSessionId, "approval-2", "No"), true);
  assert.equal(await manager.reject(startedSessionId, "approval-2", "No"), false);
  assert.equal(await manager.cancel(startedSessionId, "Stop"), true);
  assert.equal(await manager.cancel(startedSessionId, "Stop"), false);
  await running;

  assert.deepEqual(controls, ["approve:approval-1", "reject:approval-2", "cancel"]);

  db.close();
});

test("persists valid delegation control events without spawning children", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-delegation-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Delegating supervisor",
    description: "Validate a structured worker request.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-03T00:00:00.000Z" });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Delegate safely.",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: goal.id,
        runId: "run-placeholder",
        message: "Requesting a worker.",
        occurredAt: "2026-07-03T00:00:01.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.request",
            role: "worker",
            prompt: "Run focused tests.",
            summary: "Run focused tests.",
          },
        },
      },
      terminalEvent(goal.id),
    ]),
  });

  const delegations = agentSessionRepo.listDelegationRequests(result.session.id);
  const durableEvents = eventRepo.listForGoal(goal.id);

  assert.equal(delegations.length, 1);
  assert.equal(delegations[0]?.status, "accepted");
  assert.equal(delegations[0]?.role, "worker");
  assert.equal(delegations[0]?.promptSummary, "Run focused tests.");
  assert.ok(
    durableEvents.some(
      (event) =>
        event.type === "agent.progress" &&
        event.data.runtimeEventType === "delegation.accepted" &&
        event.data.delegationRequestId === delegations[0]?.id,
    ),
  );

  db.close();
});

test("rejects duplicate active delegation control events durably", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-duplicate-delegation-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Duplicate delegation",
    description: "Only one active child is allowed.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-03T00:00:00.000Z" });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });
  const controlEvent = {
    type: "managed_delegation.request",
    role: "worker",
    prompt: "Run focused tests.",
    summary: "Run focused tests.",
  };

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Try duplicate delegation.",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: goal.id,
        runId: "run-placeholder",
        message: "Requesting a worker.",
        occurredAt: "2026-07-03T00:00:01.000Z",
        metadata: { delegationControlEvent: controlEvent },
      },
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: goal.id,
        runId: "run-placeholder",
        message: "Requesting another worker.",
        occurredAt: "2026-07-03T00:00:02.000Z",
        metadata: { delegationControlEvent: controlEvent },
      },
      terminalEvent(goal.id),
    ]),
  });

  const delegations = agentSessionRepo.listDelegationRequests(result.session.id);
  const rejection = eventRepo
    .listForGoal(goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.rejected");

  assert.equal(delegations.length, 1);
  assert.equal(delegations[0]?.status, "accepted");
  assert.match(String(rejection?.data.safeReason), /active delegation/i);

  db.close();
});

function createHandle(sessionId: string, events: AgentRuntimeEvent[]): AgentSessionHandle {
  return {
    sessionId,
    capabilities: {
      eventStreaming: true,
      approval: true,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
    async *events() {
      for (const event of events) yield event;
    },
    async send() {},
    async approve() {},
    async reject() {},
    async cancel() {},
  };
}

function adapterWithEvents(events: AgentRuntimeEvent[]): AgentRuntimeAdapter {
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: true,
      };
    },
    async startSession(input) {
      return createHandle(
        input.sessionId,
        events.map((event) => ({
          ...event,
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
        })),
      );
    },
  };
}

function terminalEvent(goalId: string): AgentRuntimeEvent {
  return {
    type: "session.completed",
    sessionId: "session-placeholder",
    goalId,
    runId: "run-placeholder",
    message: "Supervisor stopped after validation.",
    occurredAt: "2026-07-03T00:00:03.000Z",
  };
}

function fixedClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}
