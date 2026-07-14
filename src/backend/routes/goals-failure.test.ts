import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository, type GoalRepository } from "../../persistence/goal-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
} from "../../persistence/runtime-repositories.js";
import { createEventBus } from "../../persistence/event-bus.js";
import { createGoalRouter } from "./goals.js";

interface Harness {
  url: string;
  db: AppDatabase;
  goalRepo: GoalRepository;
  close: () => Promise<void>;
}

function startServer(run: (goalId: string) => Promise<unknown>): Promise<Harness> {
  const db = openDatabase({ path: ":memory:" });
  const goalRepo = createGoalRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const eventBus = createEventBus();

  const app = express();
  app.use(express.json());
  app.use(
    "/api/goals",
    createGoalRouter({ goalRepo, eventRepo, eventBus, runtime: { run }, agentSessionRepo }),
  );

  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        db,
        goalRepo,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

async function createGoal(url: string): Promise<string> {
  const created = (await fetch(`${url}/api/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Failure boundary", description: "verify durable failure" }),
  }).then((r) => r.json())) as { id: string };
  return created.id;
}

function unhandledFailureEvents(db: AppDatabase, goalId: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT type, data FROM events WHERE goal_id = ?").all(goalId) as Array<{
    type: string;
    data: string;
  }>)
    .map((row) => ({ type: row.type, data: JSON.parse(row.data) as Record<string, unknown> }))
    .filter((event) => (event.data as { runtimeEventType?: string }).runtimeEventType === "runtime.unhandled_failure");
}

describe("Goal start background-run failure durability", () => {
  it("records a durable failure event and fails the goal when the background run rejects", async () => {
    const harness = await startServer(() => Promise.reject(new Error("supervisor exploded")));
    try {
      const goalId = await createGoal(harness.url);
      const res = await fetch(`${harness.url}/api/goals/${goalId}/start`, { method: "POST" });
      assert.equal(res.status, 200);

      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.equal(harness.goalRepo.getById(goalId)?.status, "failed");
      const failures = unhandledFailureEvents(harness.db, goalId);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.type, "error");
      assert.equal((failures[0]!.data as { scope?: string }).scope, "goal");
    } finally {
      await harness.close();
    }
  });

  it("leaves the success path untouched (no failure event)", async () => {
    const harness = await startServer(() => Promise.resolve());
    try {
      const goalId = await createGoal(harness.url);
      await fetch(`${harness.url}/api/goals/${goalId}/start`, { method: "POST" });

      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.equal(unhandledFailureEvents(harness.db, goalId).length, 0);
    } finally {
      await harness.close();
    }
  });
});
