import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../persistence/database.js";
import { createApp } from "./app.js";

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

async function json(res: Response) {
  return res.json() as Promise<unknown>;
}

describe("Backend API", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ url, close } = await startServer());
  });

  after(async () => {
    await close();
  });

  it("GET /health returns ok", async () => {
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body, { status: "ok" });
  });

  describe("POST /api/goals", () => {
    it("creates a goal and returns 201", async () => {
      const res = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test goal", description: "A test" }),
      });
      assert.equal(res.status, 201);
      const body = (await json(res)) as Record<string, unknown>;
      assert.equal(body.title, "Test goal");
      assert.equal(body.status, "draft");
      assert.ok(typeof body.id === "string");
    });

    it("returns 400 when title is missing", async () => {
      const res = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "missing title" }),
      });
      assert.equal(res.status, 400);
    });

    it("returns 400 when description is missing", async () => {
      const res = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "no desc" }),
      });
      assert.equal(res.status, 400);
    });
  });

  describe("GET /api/goals", () => {
    it("lists created goals", async () => {
      await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Listed goal", description: "visible" }),
      });
      const res = await fetch(`${url}/api/goals`);
      assert.equal(res.status, 200);
      const body = (await json(res)) as unknown[];
      assert.ok(Array.isArray(body));
      assert.ok(body.length >= 1);
    });
  });

  describe("GET /api/goals/:id", () => {
    it("returns goal detail", async () => {
      const created = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Detail goal", description: "detail test" }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

      const res = await fetch(`${url}/api/goals/${created.id}`);
      assert.equal(res.status, 200);
      const body = (await json(res)) as Record<string, unknown>;
      assert.equal(body.id, created.id);
      assert.equal(body.title, "Detail goal");
    });

    it("returns 404 for unknown id", async () => {
      const res = await fetch(`${url}/api/goals/nonexistent-id`);
      assert.equal(res.status, 404);
    });
  });

  describe("POST /api/goals/:id/start", () => {
    it("starts a draft goal and returns running status", async () => {
      const created = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Start me", description: "to be started" }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

      const res = await fetch(`${url}/api/goals/${created.id}/start`, {
        method: "POST",
      });
      assert.equal(res.status, 200);
      const body = (await json(res)) as Record<string, unknown>;
      assert.equal(body.status, "running");
    });

    it("returns 409 when goal is already started", async () => {
      const created = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Double start", description: "start twice" }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

      await fetch(`${url}/api/goals/${created.id}/start`, { method: "POST" });
      const res = await fetch(`${url}/api/goals/${created.id}/start`, {
        method: "POST",
      });
      assert.equal(res.status, 409);
    });

    it("returns 404 for unknown goal", async () => {
      const res = await fetch(`${url}/api/goals/bad-id/start`, {
        method: "POST",
      });
      assert.equal(res.status, 404);
    });
  });

  describe("GET /api/goals/:id/events", () => {
    it("returns goal.created event after creation", async () => {
      const created = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Events goal", description: "check events" }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

      const res = await fetch(`${url}/api/goals/${created.id}/events`);
      assert.equal(res.status, 200);
      const events = (await json(res)) as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(events));
      assert.ok(events.some((e) => e.type === "goal.created"));
    });

    it("returns 404 for unknown goal", async () => {
      const res = await fetch(`${url}/api/goals/unknown-id/events`);
      assert.equal(res.status, 404);
    });

    it("does not require run or step query APIs — events are standalone", async () => {
      const created = await fetch(`${url}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No run API needed", description: "events only" }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

      await fetch(`${url}/api/goals/${created.id}/start`, { method: "POST" });

      // Wait briefly for async runtime to finish
      await new Promise((r) => setTimeout(r, 50));

      const events = await fetch(`${url}/api/goals/${created.id}/events`).then(
        (r) => r.json() as Promise<Array<Record<string, unknown>>>,
      );
      // Timeline has meaningful events without any /api/runs or /api/steps calls
      const types = events.map((e) => e.type);
      assert.ok(types.includes("goal.created"));
      assert.ok(types.includes("run.started"));
    });
  });
});
