import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentSessionHandle,
} from "../../domain/index.js";
import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createDelegationCoordinator } from "./delegation-coordinator.js";

const CAPABILITIES: AgentRuntimeCapabilities = {
  eventStreaming: true,
  approval: false,
  cancellation: true,
  resume: false,
  childSessions: true,
};

function fakeAdapter(events: AgentRuntimeEvent[]): AgentRuntimeAdapter {
  return {
    providerId: "mock",
    async detectCapabilities() {
      return CAPABILITIES;
    },
    async startSession(input): Promise<AgentSessionHandle> {
      return {
        sessionId: input.sessionId,
        capabilities: CAPABILITIES,
        async *events() {
          for (const event of events)
            yield { ...event, sessionId: input.sessionId, goalId: input.goalId, runId: input.runId };
        },
        async send() {},
        async approve() {},
        async reject() {},
        async cancel() {},
      };
    },
  };
}

function setup(): { db: AppDatabase; goalId: string; runId: string; parentSessionId: string } {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "G", description: "d" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "m" });
  const parent = createAgentSessionRepository(db).createSession({
    goalId: goal.id,
    runId: run.id,
    providerId: "mock",
    modelLabel: "m",
    lifecycleState: "running",
    capabilities: CAPABILITIES,
  });
  return { db, goalId: goal.id, runId: run.id, parentSessionId: parent.id };
}

function unhandledDelegationFailures(db: AppDatabase, goalId: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT data FROM events WHERE goal_id = ?").all(goalId) as Array<{ data: string }>)
    .map((row) => JSON.parse(row.data) as Record<string, unknown>)
    .filter((data) => data.runtimeEventType === "runtime.unhandled_failure" && data.scope === "delegation");
}

function coordinatorDeps(db: AppDatabase) {
  return {
    runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db),
    agentSessionRepo: createAgentSessionRepository(db),
    worktreeService: { async createChildWorktree() { return { path: "/tmp/fake-worktree", label: "fake" }; } },
    worktreeAttestor: () => [] as string[],
  };
}

const completedEvent: AgentRuntimeEvent = {
  type: "session.completed",
  sessionId: "",
  goalId: "",
  runId: "",
  message: "worker done",
  occurredAt: new Date().toISOString(),
};

test("a rejecting child-outcome handler records a durable delegation-scoped failure event", async () => {
  const { db, goalId, parentSessionId } = setup();
  const coordinator = createDelegationCoordinator(coordinatorDeps(db));

  await coordinator.acceptAndStartWorker({
    parentSessionId,
    providerId: "mock",
    modelLabel: "m",
    role: "worker",
    prompt: "do it",
    promptSummary: "do it",
    adapter: fakeAdapter([completedEvent]),
    eventData: {},
    onChildOutcome: () => Promise.reject(new Error("outcome handler exploded")),
  });

  // The child stream + the rejecting outcome handler run on a detached promise.
  await new Promise((resolve) => setTimeout(resolve, 25));

  const failures = unhandledDelegationFailures(db, goalId);
  assert.equal(failures.length, 1);
  assert.ok(typeof failures[0]!.delegationRequestId === "string");
  assert.ok(typeof failures[0]!.childSessionId === "string");
});

test("a normal child outcome records no safety-net failure event", async () => {
  const { db, goalId, parentSessionId } = setup();
  const coordinator = createDelegationCoordinator(coordinatorDeps(db));

  await coordinator.acceptAndStartWorker({
    parentSessionId,
    providerId: "mock",
    modelLabel: "m",
    role: "worker",
    prompt: "do it",
    promptSummary: "do it",
    adapter: fakeAdapter([completedEvent]),
    eventData: {},
    onChildOutcome: () => Promise.resolve(),
  });

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(unhandledDelegationFailures(db, goalId).length, 0);
});
