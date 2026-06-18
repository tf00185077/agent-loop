import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../persistence/database.js";
import { createApp } from "./app.js";
import type { ProviderEnvironment } from "../runtime/provider-config.js";

function startServer(env?: ProviderEnvironment) {
  const db = openDatabase({ path: ":memory:" });
  const app = createApp(db, env ? { env } : undefined);
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

function createFakeAgentScript(dir: string): string {
  const scriptPath = join(dir, "fake-openai-local-agent.mjs");
  writeFileSync(
    scriptPath,
    `
import { writeFileSync } from "node:fs";

const capturePath = process.argv[2];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const input = JSON.parse(stdin);
  writeFileSync(capturePath, JSON.stringify(input));
  process.stdout.write(JSON.stringify({ text: "Provider-backed API response" }));
});
`.trimStart(),
  );
  return scriptPath;
}

async function waitForEvent(url: string, goalId: unknown, type: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const events = await fetch(`${url}/api/goals/${goalId}/events`).then(
      (r) => r.json() as Promise<Array<Record<string, unknown>>>,
    );
    const event = events.find((e) => e.type === type);
    if (event) return { event, events };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${type}`);
}

function assertDoesNotContainValues(value: unknown, forbiddenValues: string[]) {
  const serialized = JSON.stringify(value);
  for (const forbiddenValue of forbiddenValues) {
    assert.equal(serialized.includes(forbiddenValue), false);
  }
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

    it("drives a provider-backed run with a fake openai-local-agent provider", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-local-provider-"));
      const capturePath = join(dir, "captured-input.json");
      const scriptPath = createFakeAgentScript(dir);
      const providerServer = await startServer({
        AUTO_AGENT_PROVIDER: "openai-local-agent",
        AUTO_AGENT_OPENAI_LOCAL_COMMAND: "node",
        AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON: JSON.stringify([scriptPath, capturePath]),
        AUTO_AGENT_OPENAI_LOCAL_MODEL: "fake-local-model",
        AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS: "10000",
      });

      try {
        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Provider-backed start",
            description: "exercise openai-local-agent through the API",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);
        const started = (await json(res)) as Record<string, unknown>;
        assert.equal(started.status, "running");

        const { event, events } = await waitForEvent(
          providerServer.url,
          created.id,
          "goal.completed",
        );
        assert.equal(event.type, "goal.completed");
        assert.ok(events.some((e) => e.type === "run.started"));
        assert.ok(events.some((e) => e.type === "step.started"));
        assert.ok(
          events.some(
            (e) =>
              e.type === "agent.message" &&
              e.message === "Provider-backed API response" &&
              (e.data as Record<string, unknown>).provider === "openai-local-agent" &&
              (e.data as Record<string, unknown>).model === "fake-local-model",
          ),
        );

        const completed = (await fetch(`${providerServer.url}/api/goals/${created.id}`).then(
          (r) => r.json(),
        )) as Record<string, unknown>;
        assert.equal(completed.status, "completed");

        const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
        assert.deepEqual(captured.goal, {
          id: created.id,
          title: "Provider-backed start",
          description: "exercise openai-local-agent through the API",
        });
        assert.match(
          captured.prompt as string,
          /Title: Provider-backed start/,
        );
      } finally {
        await providerServer.close();
      }
    });

    it("fails visibly when openai-local-agent command configuration is missing", async () => {
      const providerServer = await startServer({
        AUTO_AGENT_PROVIDER: "openai-local-agent",
      });

      try {
        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Missing local command",
            description: "should fail through durable runtime state",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);
        const started = (await json(res)) as Record<string, unknown>;
        assert.equal(started.status, "running");

        const { event } = await waitForEvent(providerServer.url, created.id, "error");
        assert.equal(event.message, "AUTO_AGENT_OPENAI_LOCAL_COMMAND is required");

        const failed = (await fetch(`${providerServer.url}/api/goals/${created.id}`).then(
          (r) => r.json(),
        )) as Record<string, unknown>;
        assert.equal(failed.status, "failed");
        assert.ok(typeof failed.completedAt === "string");
      } finally {
        await providerServer.close();
      }
    });

    it("does not expose provider secrets or local command credential material", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-secret-check-"));
      const capturePath = join(dir, "captured-input.json");
      const scriptPath = createFakeAgentScript(dir);
      const secretArg = "local-command-secret-token";
      const providerServer = await startServer({
        AUTO_AGENT_PROVIDER: "openai-local-agent",
        AUTO_AGENT_OPENAI_LOCAL_COMMAND: "node",
        AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON: JSON.stringify([
          scriptPath,
          capturePath,
          "--token",
          secretArg,
        ]),
        AUTO_AGENT_OPENAI_LOCAL_MODEL: "fake-local-model",
        AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS: "10000",
        AUTO_AGENT_API_KEY: "unused-api-secret",
      });

      try {
        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Secret-safe provider start",
            description: "dashboard responses must stay sanitized",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const started = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        const { events } = await waitForEvent(
          providerServer.url,
          created.id,
          "goal.completed",
        );
        const detail = await fetch(`${providerServer.url}/api/goals/${created.id}`).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
        const list = await fetch(`${providerServer.url}/api/goals`).then(
          (r) => r.json() as Promise<unknown[]>,
        );

        assertDoesNotContainValues([created, started, detail, list, events], [
          scriptPath,
          capturePath,
          secretArg,
          "unused-api-secret",
        ]);
      } finally {
        await providerServer.close();
      }
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
