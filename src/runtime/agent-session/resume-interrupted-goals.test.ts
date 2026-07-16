import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRuntimeAdapter, AgentRuntimeCapabilities, AgentSessionHandle } from "../../domain/index.js";
import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { createAgentSessionRepository, createEventRepository, createRunRepository } from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";

const CAPS: AgentRuntimeCapabilities = { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };

function capturingAdapter(onStart: (prompt: string) => void, mode: "empty" | "throw" = "empty"): AgentRuntimeAdapter {
  return {
    providerId: "mock",
    async detectCapabilities() {
      return CAPS;
    },
    async startSession(input): Promise<AgentSessionHandle> {
      onStart(input.prompt);
      if (mode === "throw") throw new Error("adapter refused to start");
      return {
        sessionId: input.sessionId, capabilities: CAPS,
        async *events() { /* no events: session ends immediately */ },
        async send() {}, async approve() {}, async reject() {}, async cancel() {},
      };
    },
  };
}

function seedInterruptedGoal(db: AppDatabase, status: "interrupted" | "running" = "interrupted"): string {
  const goal = createGoalRepository(db).create({ title: "Resume me", description: "d" });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({ goalId: goal.id, tasks: [{ id: "task-1", title: "T", acceptance: [{ id: "A1", text: "x" }] }] });
  createGoalRepository(db).updateStatus(goal.id, status, { startedAt: "2026-07-16T00:00:00.000Z" });
  return goal.id;
}

function manager(db: AppDatabase, adapter: AgentRuntimeAdapter) {
  const mgr = createAgentSessionManager({
    goalRepo: createGoalRepository(db), runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db), agentSessionRepo: createAgentSessionRepository(db),
    managedTaskRepo: createManagedTaskRepository(db), database: db,
    maxSupervisorContinuations: 0,
  });
  return mgr;
}

function eventsOfType(db: AppDatabase, type: string): number {
  return (db.prepare("SELECT data FROM events").all() as Array<{ data: string }>)
    .map((r) => JSON.parse(r.data) as Record<string, unknown>)
    .filter((d) => d.runtimeEventType === type).length;
}

test("resumeInterruptedGoal starts a continuation session and records a resume event", async () => {
  const db = openDatabase({ path: ":memory:" });
  const goalId = seedInterruptedGoal(db);
  let capturedPrompt = "";
  let startCalls = 0;
  const adapter = capturingAdapter((p) => { capturedPrompt = capturedPrompt || p; startCalls += 1; });

  await manager(db, adapter).resumeInterruptedGoal({ goalId, providerId: "mock", modelLabel: "m", adapter });

  assert.equal(startCalls, 1);
  assert.match(capturedPrompt, /Resumed after backend restart/, "prompt is a continuation, not a bootstrap");
  assert.equal(eventsOfType(db, "recovery.resumed"), 1);
  assert.notEqual(createGoalRepository(db).getById(goalId)?.status, "interrupted", "goal was flipped out of interrupted");
  db.close();
});

test("resumeInterruptedGoal does not resume a goal that is not interrupted", async () => {
  const db = openDatabase({ path: ":memory:" });
  const goalId = seedInterruptedGoal(db, "running");
  let startCalls = 0;
  const adapter = capturingAdapter(() => { startCalls += 1; });

  await manager(db, adapter).resumeInterruptedGoal({ goalId, providerId: "mock", modelLabel: "m", adapter });

  assert.equal(startCalls, 0);
  assert.equal(eventsOfType(db, "recovery.resumed"), 0);
  db.close();
});

test("a resume whose session start throws is recorded durably and left interrupted", async () => {
  const db = openDatabase({ path: ":memory:" });
  const goalId = seedInterruptedGoal(db);
  const adapter = capturingAdapter(() => {}, "throw");

  await manager(db, adapter).resumeInterruptedGoal({ goalId, providerId: "mock", modelLabel: "m", adapter });

  assert.equal(createGoalRepository(db).getById(goalId)?.status, "interrupted");
  assert.equal(eventsOfType(db, "recovery.resume_failed"), 1);
  db.close();
});

test("crash-to-continue survives a restart end to end: running -> interrupted -> running", async () => {
  const db = openDatabase({ path: ":memory:" });
  const goals = createGoalRepository(db);
  const goal = goals.create({ title: "E2E", description: "d" });
  goals.updateStatus(goal.id, "running", { startedAt: "2026-07-16T00:00:00.000Z" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "m" });
  createAgentSessionRepository(db).createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "m", lifecycleState: "running", capabilities: CAPS,
  });
  createManagedTaskRepository(db).registerTasks({
    goalId: goal.id, tasks: [{ id: "task-1", title: "T", acceptance: [{ id: "A1", text: "x" }] }],
  });

  let capturedPrompt = "";
  const adapter = capturingAdapter((p) => { capturedPrompt = capturedPrompt || p; });
  const mgr = manager(db, adapter);

  // Phase 3a: reconcile the crash-interrupted goal.
  mgr.recoverOrphanedSessions();
  assert.equal(goals.getById(goal.id)?.status, "interrupted");

  // Phase 3b: resume it from the durable projection.
  await mgr.resumeInterruptedGoal({ goalId: goal.id, providerId: "mock", modelLabel: "m", adapter });
  assert.notEqual(goals.getById(goal.id)?.status, "interrupted", "goal returned to running under a resumed session");
  assert.match(capturedPrompt, /Resumed after backend restart/, "resumed via a continuation, not a fresh bootstrap");
  db.close();
});
