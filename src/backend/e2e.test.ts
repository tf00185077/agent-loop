import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../persistence/database.js";
import { createApp } from "./app.js";

// End-to-end verification of the MVP demo path over real HTTP:
// create a goal -> start it -> read its durable event timeline.
// This proves the full vertical slice without using any dedicated
// run or step query APIs.

function startServer() {
  const db = openDatabase({ path: ":memory:" });
  const app = createApp(db);
  const server = createServer(app);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      const close = () =>
        new Promise<void>((res, rej) =>
          server.close((err) => (err ? rej(err) : res())),
        );
      resolve({ url, close });
    });
  });
}

type Json = Record<string, unknown>;

async function createGoal(url: string, body: Json): Promise<Json> {
  const res = await fetch(`${url}/api/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Json;
}

async function readEvents(url: string, goalId: string): Promise<Json[]> {
  const res = await fetch(`${url}/api/goals/${goalId}/events`);
  assert.equal(res.status, 200);
  return (await res.json()) as Json[];
}

describe("E2E: create goal, start goal, read event timeline", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ url, close } = await startServer());
  });

  after(async () => {
    await close();
  });

  it("completes the happy path lifecycle visible only through events", async () => {
    // 1. Create a goal
    const goal = await createGoal(url, {
      title: "Ship the vertical slice",
      description: "Prove the full lifecycle end to end",
    });
    assert.equal(goal.status, "draft");

    // Timeline starts with goal.created
    const afterCreate = await readEvents(url, goal.id as string);
    assert.deepEqual(
      afterCreate.map((e) => e.type),
      ["goal.created"],
    );

    // 2. Start the goal
    const startRes = await fetch(`${url}/api/goals/${goal.id}/start`, {
      method: "POST",
    });
    assert.equal(startRes.status, 200);
    assert.equal(((await startRes.json()) as Json).status, "running");

    // 3. Read the durable event timeline
    const events = await readEvents(url, goal.id as string);
    const types = events.map((e) => e.type);

    // The timeline alone is sufficient to understand lifecycle progress.
    assert.ok(types.includes("goal.created"), "has goal.created");
    assert.ok(types.includes("run.started"), "has run.started");
    assert.ok(types.includes("step.started"), "has step.started");
    assert.ok(types.includes("agent.message"), "has agent.message");
    assert.ok(types.includes("step.completed"), "has step.completed");
    assert.ok(types.includes("run.completed"), "has run.completed");
    assert.ok(types.includes("goal.completed"), "has goal.completed");

    // Creation order: goal.created is first, goal.completed is terminal,
    // and run.started precedes the first step.
    assert.equal(types[0], "goal.created");
    assert.equal(types[types.length - 1], "goal.completed");
    assert.ok(
      types.indexOf("run.started") < types.indexOf("step.started"),
      "run.started precedes step.started",
    );

    // Every event references the goal and carries a human-readable message.
    for (const e of events) {
      assert.equal(e.goalId, goal.id);
      assert.ok(typeof e.message === "string" && (e.message as string).length > 0);
    }

    // 4. Goal detail reflects the terminal state after the run.
    const detail = (await fetch(`${url}/api/goals/${goal.id}`).then((r) =>
      r.json(),
    )) as Json;
    assert.equal(detail.status, "completed");
  });

  it("supports the deterministic blocked path through events", async () => {
    const goal = await createGoal(url, {
      title: "block this goal",
      description: "should reach blocked terminal state",
    });

    await fetch(`${url}/api/goals/${goal.id}/start`, { method: "POST" });

    const types = (await readEvents(url, goal.id as string)).map((e) => e.type);
    assert.ok(types.includes("run.started"));
    assert.ok(types.includes("goal.blocked"), "has goal.blocked");

    const detail = (await fetch(`${url}/api/goals/${goal.id}`).then((r) =>
      r.json(),
    )) as Json;
    assert.equal(detail.status, "blocked");
  });
});
