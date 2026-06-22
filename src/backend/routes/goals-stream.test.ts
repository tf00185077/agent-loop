import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../persistence/database.js";
import { createApp } from "../app.js";

function startServer() {
  const db = openDatabase({ path: ":memory:" });
  const app = createApp(db, { env: { AUTO_AGENT_PROVIDER: "mock" } });
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

/** Reads SSE `data: ...` lines from a streaming response body until `count` events arrive or it times out. */
async function readSseEvents(
  res: Response,
  count: number,
  timeoutMs = 5_000,
): Promise<{ events: Record<string, unknown>[]; closedByServer: boolean }> {
  const body = res.body;
  if (!body) throw new Error("Response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  let closedByServer = false;
  const deadline = Date.now() + timeoutMs;

  try {
    while (events.length < count) {
      if (Date.now() > deadline) break;
      const { value, done } = await reader.read();
      if (done) {
        closedByServer = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataLine = rawEvent
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          events.push(JSON.parse(dataLine.slice("data: ".length)));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { events, closedByServer };
}

describe("Goal live event stream", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ url, close } = await startServer());
  });

  after(async () => {
    await close();
  });

  it("404s for an unknown goal", async () => {
    const res = await fetch(`${url}/api/goals/missing-goal/events/stream`);
    assert.equal(res.status, 404);
  });

  it("streams events for a running goal as text/event-stream", async () => {
    const created = await fetch(`${url}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Stream me",
        description: "Verify the live event stream",
      }),
    }).then((r) => r.json() as Promise<{ id: string }>);

    const streamRes = await fetch(`${url}/api/goals/${created.id}/events/stream`);
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type") ?? "", /text\/event-stream/);

    await fetch(`${url}/api/goals/${created.id}/start`, { method: "POST" });

    const { events } = await readSseEvents(streamRes, 1);
    assert.equal(events[0]?.goalId, created.id);
    assert.ok(typeof events[0]?.type === "string");
  });

  it("streamed events match the durable snapshot record by id, so reconnect dedup is sound", async () => {
    const created = await fetch(`${url}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Reconnect-safe goal",
        description: "Verify snapshot and stream agree on event identity",
      }),
    }).then((r) => r.json() as Promise<{ id: string }>);

    const streamRes = await fetch(`${url}/api/goals/${created.id}/events/stream`);
    await fetch(`${url}/api/goals/${created.id}/start`, { method: "POST" });

    const { events: streamedEvents } = await readSseEvents(streamRes, 50, 5_000);
    const snapshot = await fetch(`${url}/api/goals/${created.id}/events`).then(
      (r) => r.json() as Promise<Array<Record<string, unknown>>>,
    );

    assert.ok(streamedEvents.length > 0);
    for (const streamedEvent of streamedEvents) {
      const snapshotEvent = snapshot.find((event) => event.id === streamedEvent.id);
      assert.ok(snapshotEvent, `streamed event ${streamedEvent.id} must also be in the snapshot`);
      assert.deepEqual(snapshotEvent, streamedEvent);
    }
  });

  it("ends the stream once a terminal event is published", async () => {
    const created = await fetch(`${url}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Stream until terminal",
        description: "Verify terminal cleanup",
      }),
    }).then((r) => r.json() as Promise<{ id: string }>);

    const streamRes = await fetch(`${url}/api/goals/${created.id}/events/stream`);
    await fetch(`${url}/api/goals/${created.id}/start`, { method: "POST" });

    const { events, closedByServer } = await readSseEvents(streamRes, 50, 5_000);
    const terminalTypes = new Set(["goal.completed", "goal.blocked", "error"]);
    assert.ok(events.some((event) => terminalTypes.has(event.type as string)));
    assert.equal(closedByServer, true, "stream should be closed by the server after the terminal event");
  });
});
