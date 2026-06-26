import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";
import { createEventBus } from "./event-bus.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
  createStepRepository,
} from "./runtime-repositories.js";

test("creates and updates run records for a goal", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Runtime goal",
    description: "Exercise run persistence.",
  });
  const runs = createRunRepository(db);

  const run = runs.create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
  const completed = runs.updateStatus(run.id, "completed", {
    finishedAt: "2026-06-15T09:00:00.000Z",
  });

  assert.equal(run.goalId, goal.id);
  assert.equal(run.status, "running");
  assert.equal(completed.status, "completed");
  assert.equal(completed.finishedAt, "2026-06-15T09:00:00.000Z");
  assert.deepEqual(runs.getById(run.id), completed);
  assert.equal(runs.getById("missing"), null);

  db.close();
});

test("creates, updates, and lists step records for a run", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Step goal",
    description: "Exercise step persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
  const steps = createStepRepository(db);

  const second = steps.create({
    goalId: goal.id,
    runId: run.id,
    title: "Second step",
    description: "Runs second.",
    order: 2,
  });
  const first = steps.create({
    goalId: goal.id,
    runId: run.id,
    title: "First step",
    description: "Runs first.",
    order: 1,
  });
  const completed = steps.update(first.id, { status: "completed", result: "Done" });

  assert.equal(first.status, "pending");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "Done");
  assert.deepEqual(
    steps.listForRun(run.id).map((step) => step.id),
    [first.id, second.id],
  );
  assert.throws(() => steps.update("missing", { status: "running" }), /Step not found/);

  db.close();
});

test("creates and lists event records for a goal timeline", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Event goal",
    description: "Exercise event persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "mock-agent-v1" });
  const step = createStepRepository(db).create({
    goalId: goal.id,
    runId: run.id,
    title: "Mock step",
    description: "Produces an event.",
    order: 1,
  });
  const events = createEventRepository(db);

  const started = events.create({
    goalId: goal.id,
    runId: run.id,
    type: "run.started",
    message: "Run started.",
    data: { provider: "mock" },
  });
  const message = events.create({
    goalId: goal.id,
    runId: run.id,
    stepId: step.id,
    type: "agent.message",
    message: "Working on the goal.",
  });

  assert.equal(started.stepId, null);
  assert.deepEqual(started.data, { provider: "mock" });
  assert.deepEqual(message.data, {});
  assert.deepEqual(
    events.listForGoal(goal.id).map((event) => event.id),
    [started.id, message.id],
  );

  db.close();
});

test("round-trips optional agent observation metadata through event persistence", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Observation metadata goal",
    description: "Exercise future subagent metadata.",
  });
  const events = createEventRepository(db);

  const created = events.create({
    goalId: goal.id,
    type: "agent.subtask.completed",
    message: "Subtask completed.",
    data: {
      observationKind: "subtask.completed",
      provider: "codex-cli",
      model: "gpt-5-codex",
      agentRole: "worker",
      agentId: "agent-child",
      parentAgentId: "agent-main",
      taskId: "task-42",
      source: "jsonl",
      rawEventType: "item.completed",
    },
  });

  assert.deepEqual(events.listForGoal(goal.id)[0], created);

  db.close();
});

test("publishes each event to the event bus after it is durably persisted", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Published goal",
    description: "Exercise event publication.",
  });
  const bus = createEventBus();
  const received: unknown[] = [];
  bus.subscribe(goal.id, (event) => received.push(event));
  const events = createEventRepository(db, { eventBus: bus });

  const created = events.create({
    goalId: goal.id,
    type: "goal.created",
    message: "Goal created.",
  });

  assert.deepEqual(events.listForGoal(goal.id), [created]);
  assert.deepEqual(received, [created]);

  db.close();
});

test("creates agent sessions and updates lifecycle state", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Managed session goal",
    description: "Exercise session persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const sessions = createAgentSessionRepository(db, {
    now: fixedClock(["2026-06-26T00:00:00.000Z", "2026-06-26T00:00:05.000Z"]),
  });

  const session = sessions.createSession({
    goalId: goal.id,
    runId: run.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "starting",
    capabilities: {
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: false,
      unsupportedReasons: { approval: "Codex exec mode cannot resume approvals." },
    },
    parent: {
      sessionId: "parent-session",
      agentId: "agent-parent",
      taskId: "task-1",
    },
  });
  const running = sessions.updateLifecycleState(session.id, "running");

  assert.equal(session.goalId, goal.id);
  assert.equal(session.providerId, "codex-local");
  assert.equal(session.lifecycleState, "starting");
  assert.equal(session.createdAt, "2026-06-26T00:00:00.000Z");
  assert.equal(running.lifecycleState, "running");
  assert.equal(running.createdAt, session.createdAt);
  assert.equal(running.lastActivityAt, "2026-06-26T00:00:05.000Z");
  assert.deepEqual(sessions.getSession(session.id), running);
  assert.deepEqual(sessions.listSessionsForGoal(goal.id), [running]);

  db.close();
});

test("stores pending approvals and resolves them idempotently", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Approval goal",
    description: "Exercise approval persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const sessions = createAgentSessionRepository(db, {
    now: fixedClock([
      "2026-06-26T00:00:00.000Z",
      "2026-06-26T00:00:01.000Z",
      "2026-06-26T00:00:02.000Z",
      "2026-06-26T00:00:03.000Z",
    ]),
  });
  const session = sessions.createSession({
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
  const command = sessions.recordCommand({
    sessionId: session.id,
    status: "pending",
    safeCommand: "npm.cmd test",
    cwd: "C:\\Users\\TIM\\Desktop\\self\\auto-agent",
    startedAt: null,
    completedAt: null,
    exitCode: null,
    diagnostics: null,
  });
  const approval = sessions.createApprovalRequest({
    sessionId: session.id,
    commandId: command.id,
    safeSummary: "Run tests",
  });
  const approved = sessions.resolveApprovalRequest(approval.id, "approved");
  const duplicate = sessions.resolveApprovalRequest(approval.id, "rejected", "Too late");

  assert.equal(approval.status, "pending");
  assert.equal(approval.command?.safeCommand, "npm.cmd test");
  assert.equal(approved.status, "approved");
  assert.equal(approved.resolvedAt, "2026-06-26T00:00:03.000Z");
  assert.equal(duplicate.status, "approved");
  assert.equal(duplicate.resolutionReason, null);
  assert.deepEqual(sessions.listApprovalRequests(session.id), [duplicate]);

  db.close();
});

test("records child-session requests for future orchestration", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const goal = createGoalRepository(db).create({
    title: "Child session goal",
    description: "Exercise child request persistence.",
  });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const sessions = createAgentSessionRepository(db, {
    now: fixedClock(["2026-06-26T00:00:00.000Z", "2026-06-26T00:00:01.000Z"]),
  });
  const session = sessions.createSession({
    goalId: goal.id,
    runId: run.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "running",
    capabilities: {
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
  });

  const childRequest = sessions.recordChildSessionRequest({
    parentSessionId: session.id,
    parentAgentId: "agent-main",
    childRole: "reviewer",
    taskId: "task-12",
    promptSummary: "Review persistence implementation.",
    status: "unsupported",
    resolvedAt: "2026-06-26T00:00:02.000Z",
    safeReason: "Child-session scheduling is not enabled.",
  });

  assert.equal(childRequest.parentSessionId, session.id);
  assert.equal(childRequest.status, "unsupported");
  assert.deepEqual(sessions.listChildSessionRequests(session.id), [childRequest]);

  db.close();
});

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "auto-agent-runtime-")), "runtime.sqlite");
}

function fixedClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
