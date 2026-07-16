import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRuntimeAdapter, AgentRuntimeCapabilities, AgentRuntimeEvent, AgentSessionHandle } from "../../domain/index.js";
import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createAgentSessionRepository, createEventRepository, createRunRepository } from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";

const CAPS: AgentRuntimeCapabilities = { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };

test("updateProviderSessionId persists the provider-native session id on the session record", () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "G", description: "d" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "codex-local", model: "m" });
  const sessions = createAgentSessionRepository(db);
  const session = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "codex-local", modelLabel: "m", lifecycleState: "running", capabilities: CAPS,
  });
  assert.equal(sessions.getSession(session.id)?.providerSessionId ?? null, null);

  sessions.updateProviderSessionId(session.id, "codex-rollout-123");
  assert.equal(sessions.getSession(session.id)?.providerSessionId, "codex-rollout-123");
  db.close();
});

function adapterEmitting(events: Array<Partial<AgentRuntimeEvent>>): AgentRuntimeAdapter {
  return {
    providerId: "mock",
    async detectCapabilities() { return CAPS; },
    async startSession(input): Promise<AgentSessionHandle> {
      return {
        sessionId: input.sessionId, capabilities: CAPS,
        async *events() {
          for (const e of events) {
            yield {
              type: "session.state_changed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "e", occurredAt: new Date().toISOString(), ...e,
            } as AgentRuntimeEvent;
          }
        },
        async send() {}, async approve() {}, async reject() {}, async cancel() {},
      };
    },
  };
}

test("the manager persists the provider session id observed on a session event", async () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "Persist", description: "d" });
  const sessions = createAgentSessionRepository(db);
  const adapter = adapterEmitting([
    { metadata: { providerSessionId: "codex-abc" } },
    { type: "session.completed", message: "done" },
  ]);
  const mgr = createAgentSessionManager({
    goalRepo: createGoalRepository(db), runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db), agentSessionRepo: sessions, database: db, maxSupervisorContinuations: 0,
  });

  await mgr.startManagedSession({ goalId: goal.id, providerId: "mock", modelLabel: "m", adapter });

  const session = sessions.listSessionsForGoal(goal.id)[0];
  assert.equal(session?.providerSessionId, "codex-abc");
  db.close();
});

test("a session that reports no provider session id leaves it null", async () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "None", description: "d" });
  const sessions = createAgentSessionRepository(db);
  const adapter = adapterEmitting([{ type: "session.completed", message: "done" }]);
  const mgr = createAgentSessionManager({
    goalRepo: createGoalRepository(db), runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db), agentSessionRepo: sessions, database: db, maxSupervisorContinuations: 0,
  });

  await mgr.startManagedSession({ goalId: goal.id, providerId: "mock", modelLabel: "m", adapter });

  assert.equal(sessions.listSessionsForGoal(goal.id)[0]?.providerSessionId ?? null, null);
  db.close();
});
