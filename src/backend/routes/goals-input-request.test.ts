import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Supervisor that proposes a plan on bootstrap and signals ready on the turn. */
function proposingAdapter(): AgentRuntimeAdapter {
  let turn = 0;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      turn += 1;
      const block = turn === 1
        ? { type: "managed_goal.propose_plan", summary: "Plan: build then ship.", items: ["Build"] }
        : /READ-ONLY clarification/.test(input.prompt)
          ? { type: "managed_goal.ready_to_proceed", summary: "Ready." }
          : null;
      const events = [];
      if (block) {
        events.push({
          type: "progress" as const, sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "block", occurredAt: `2026-07-20T00:0${turn}:00.000Z`,
          metadata: { delegationControlEvent: block },
        });
      }
      events.push({
        type: "session.completed" as const, sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "ended", occurredAt: `2026-07-20T00:0${turn}:09.000Z`,
      });
      return createHandle(input.sessionId, events);
    },
  };
}

test("a conversation request exposes its thread and accepts a guidance reply", async () => {
  const fixture = createManagerFixture("conversation routes");
  const adapter = proposingAdapter();
  const manager = createAgentSessionManager({ ...fixture });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const app = express();
  app.use(express.json());
  app.use("/api/goals", createGoalRouter({
    goalRepo: fixture.goalRepo, eventRepo: fixture.eventRepo, eventBus: createEventBus(),
    agentSessionRepo: fixture.agentSessionRepo, goalInputRequestRepo: fixture.goalInputRequestRepo,
    runtime: {
      run: async () => undefined,
      respondToInput: (goalId, requestId, body) => manager.respondToGoalInputRequest({
        goalId, requestId, body, runtime: { providerId: "codex-local", modelLabel: "gpt-5-codex", adapter },
      }),
    },
  }));
  const server = createServer(app);
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  try {
    const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id)!;
    const get = await fetch(`${url}/api/goals/${fixture.goal.id}/input-request`);
    const body = (await get.json()) as Record<string, any>;
    assert.equal(body.reasonCode, "plan_confirmation");
    assert.equal(body.payload.phase, "awaiting_caller");
    assert.equal(body.payload.thread.length, 1);
    assert.deepEqual(body.payload.allowedDecisions, ["provide_guidance", "proceed", "abandon"]);

    // A guidance reply runs the conversational turn, which signals ready → resumed.
    const respond = await fetch(`${url}/api/goals/${fixture.goal.id}/input-request/${pending.id}/respond`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "provide_guidance", guidance: "Looks good." }),
    });
    assert.equal(respond.status, 200);
    const outcome = ((await respond.json()) as { outcome: string }).outcome;
    assert.ok(["resumed", "conversation_continued"].includes(outcome));
  } finally {
    await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
    fixture.db.close();
  }
});

test("goal creation validates the workspace", async () => {
  const fixture = createManagerFixture("workspace validation");
  const app = express();
  app.use(express.json());
  app.use("/api/goals", createGoalRouter({
    goalRepo: fixture.goalRepo, eventRepo: fixture.eventRepo, eventBus: createEventBus(),
    agentSessionRepo: fixture.agentSessionRepo, goalInputRequestRepo: fixture.goalInputRequestRepo,
    runtime: { run: async () => undefined },
  }));
  const server = createServer(app);
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  const create = (body: Record<string, unknown>) => fetch(`${url}/api/goals`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    // Valid: an existing absolute directory (the OS temp dir).
    const okRes = await create({ title: "ws goal", description: "d", workspace: tmpdir() });
    assert.equal(okRes.status, 201);
    assert.equal((await okRes.json() as { workspace: string }).workspace, tmpdir());

    // Omitted → null (server default).
    const noneRes = await create({ title: "no ws", description: "d" });
    assert.equal((await noneRes.json() as { workspace: string | null }).workspace, null);

    for (const [ws, pat] of [
      ["relative/path", /absolute/i],
      [join(tmpdir(), "does-not-exist-" + Date.now()), /does not exist/i],
    ] as const) {
      const bad = await create({ title: "bad", description: "d", workspace: ws });
      assert.equal(bad.status, 400, `expected 400 for ${ws}`);
      assert.match((await bad.json() as { error: string }).error, pat);
    }

    // A path that is a file, not a directory.
    const filePath = join(mkdtempSync(join(tmpdir(), "ws-file-")), "afile.txt");
    writeFileSync(filePath, "x");
    const fileRes = await create({ title: "file", description: "d", workspace: filePath });
    assert.equal(fileRes.status, 400);
    assert.match((await fileRes.json() as { error: string }).error, /not a directory/i);
  } finally {
    await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
    fixture.db.close();
  }
});
