import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import express from "express";

import type { AgentRuntimeAdapter } from "../../domain/index.js";
import { createEventBus } from "../../persistence/event-bus.js";
import { createAgentSessionManager } from "../../runtime/agent-session/agent-session-manager.js";
import {
  createHandle,
  createManagerFixture,
  waitFor,
} from "../../runtime/agent-session/agent-session-test-harness.js";
import { createGoalRouter } from "./goals.js";

/** Escalation routes: pending read, respond application, and status mapping. */

function completionlessAdapter(): AgentRuntimeAdapter {
  let turn = 0;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
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

async function startEscalatedServer() {
  const fixture = createManagerFixture("escalation routes");
  const adapter = completionlessAdapter();
  const manager = createAgentSessionManager({ ...fixture, maxSupervisorContinuations: 1 });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const app = express();
  app.use(express.json());
  app.use(
    "/api/goals",
    createGoalRouter({
      goalRepo: fixture.goalRepo,
      eventRepo: fixture.eventRepo,
      eventBus: createEventBus(),
      agentSessionRepo: fixture.agentSessionRepo,
      goalInputRequestRepo: fixture.goalInputRequestRepo,
      runtime: {
        run: async () => undefined,
        respondToInput: (goalId, requestId, body) =>
          manager.respondToGoalInputRequest({
            goalId, requestId, body,
            runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
          }),
      },
    }),
  );

  const server = createServer(app);
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  return {
    url, fixture,
    close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
  };
}

test("GET input-request returns the pending structured request and 404s otherwise", async () => {
  const { url, fixture, close } = await startEscalatedServer();
  try {
    const res = await fetch(`${url}/api/goals/${fixture.goal.id}/input-request`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.reasonCode, "continuation_exhausted");
    assert.equal(body.status, "pending");
    const payload = body.payload as Record<string, unknown>;
    assert.deepEqual(payload.allowedDecisions, ["extend_budget", "provide_guidance", "abandon"]);

    const other = fixture.goalRepo.create({ title: "no escalation", description: "none" });
    const none = await fetch(`${url}/api/goals/${other.id}/input-request`);
    assert.equal(none.status, 404);

    const missing = await fetch(`${url}/api/goals/no-such-goal/input-request`);
    assert.equal(missing.status, 404);
  } finally {
    await close();
    fixture.db.close();
  }
});

test("POST respond applies a valid decision and maps invalid and resolved responses", async () => {
  const { url, fixture, close } = await startEscalatedServer();
  try {
    const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;
    const respondUrl = `${url}/api/goals/${fixture.goal.id}/input-request/${pending.id}/respond`;

    const invalid = await fetch(respondUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "extend_budget", extension: 99 }),
    });
    assert.equal(invalid.status, 400);
    assert.match(((await invalid.json()) as { error: string }).error, /between 1 and 1/);

    const accepted = await fetch(respondUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "extend_budget", extension: 1 }),
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = (await accepted.json()) as { outcome: string; request: { status: string } };
    assert.equal(acceptedBody.outcome, "resumed");
    assert.equal(acceptedBody.request.status, "accepted");

    const again = await fetch(respondUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "abandon" }),
    });
    assert.equal(again.status, 409);
    const conflict = (await again.json()) as { error: string; standing: { status: string } };
    assert.match(conflict.error, /accepted/);
    assert.equal(conflict.standing.status, "accepted");

    const unknown = await fetch(`${url}/api/goals/${fixture.goal.id}/input-request/nope/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "abandon" }),
    });
    assert.equal(unknown.status, 404);
  } finally {
    await close();
    fixture.db.close();
  }
});
