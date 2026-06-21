import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../persistence/database.js";
import { createApp } from "./app.js";
import type { ProviderEnvironment } from "../runtime/provider-config.js";
import type { CodexLocalConnectionTestOptions } from "../runtime/codex-local-connection-test.js";
import type { CodexCliDetectionOptions } from "../runtime/codex-cli-detection.js";
import type { CodexModelCatalogOptions } from "../runtime/codex-local-model-catalog.js";

function startServer(
  env?: ProviderEnvironment,
  appOptions?: Omit<Parameters<typeof createApp>[1], "env">,
) {
  const db = openDatabase({ path: ":memory:" });
  const app = createApp(db, { ...(appOptions ?? {}), ...(env ? { env } : {}) });
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

/**
 * Writes an executable fake `codex` binary that captures argv + stdin to
 * capturePath and writes `response` to the `--output-last-message` file. The
 * returned path is fed to the provider via injected detection, so the Codex
 * direct-spawn provider's own arg building is exercised end to end.
 */
function createFakeCodexScript(dir: string, capturePath: string, response: string): string {
  const scriptPath = join(dir, "fake-codex.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  writeFileSync(process.argv[outputIndex + 1], ${JSON.stringify(response)});
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`,
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function detectedCodexResult(commandPath: string) {
  return {
    detected: true,
    commandPath,
    source: "manual" as const,
    status: { state: "detected" as const, detected: true, checkedAt: null, message: "ok" },
  };
}

async function waitForEvent(url: string, goalId: unknown, type: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
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

  describe("Provider settings API", () => {
    it("reads default mock provider settings", async () => {
      const providerServer = await startServer();

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings`);
        assert.equal(res.status, 200);
        assert.deepEqual(await json(res), {
          provider: "mock",
          modelLabel: "mock-v1",
          codexCommandPath: null,
          status: {
            state: "not_checked",
            detected: false,
            checkedAt: null,
            message: null,
          },
        });
      } finally {
        await providerServer.close();
      }
    });

    it("saves mock provider settings", async () => {
      const providerServer = await startServer();

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "mock" }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await json(res), {
          provider: "mock",
          modelLabel: "mock-v1",
          codexCommandPath: null,
          status: {
            state: "not_checked",
            detected: false,
            checkedAt: null,
            message: null,
          },
        });
      } finally {
        await providerServer.close();
      }
    });

    it("saves Codex Local provider settings with model label and command path", async () => {
      const providerServer = await startServer();

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: " gpt-5-codex-subscription ",
            codexCommandPath: " C:\\Tools\\codex.cmd ",
          }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await json(res), {
          provider: "codex-local",
          modelLabel: "gpt-5-codex-subscription",
          codexCommandPath: "C:\\Tools\\codex.cmd",
          status: {
            state: "not_checked",
            detected: false,
            checkedAt: null,
            message: null,
          },
        });
      } finally {
        await providerServer.close();
      }
    });

    it("returns saved provider status after detection", async () => {
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Tools\\codex.cmd",
          source: "manual",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message: "Fake detection ok",
          },
        }),
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex-subscription",
            codexCommandPath: "C:\\Tools\\codex.cmd",
          }),
        });
        await fetch(`${providerServer.url}/api/provider-settings/detect`, {
          method: "POST",
        });

        const res = await fetch(`${providerServer.url}/api/provider-settings`);
        const body = (await json(res)) as Record<string, unknown>;
        assert.equal(res.status, 200);
        assert.equal(body.codexCommandPath, "C:\\Tools\\codex.cmd");
        assert.deepEqual(body.status, {
          state: "detected",
          detected: true,
          checkedAt: null,
          message: "Fake detection ok",
        });
      } finally {
        await providerServer.close();
      }
    });

    it("persists detected Codex CLI path when command path is empty", async () => {
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Tools\\codex.cmd",
          source: "path",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message: "Codex CLI detected on PATH.",
          },
        }),
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex-subscription",
            codexCommandPath: null,
          }),
        });

        await fetch(`${providerServer.url}/api/provider-settings/detect`, {
          method: "POST",
        });

        const res = await fetch(`${providerServer.url}/api/provider-settings`);
        const body = (await json(res)) as Record<string, unknown>;
        assert.equal(res.status, 200);
        assert.equal(body.codexCommandPath, "C:\\Tools\\codex.cmd");
      } finally {
        await providerServer.close();
      }
    });

    it("replaces stale saved Codex CLI path after successful detection", async () => {
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Users\\TIM\\.vscode\\extensions\\openai.chatgpt\\codex.exe",
          source: "path",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message: "Codex CLI detected on PATH.",
          },
        }),
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "mock-v1",
            codexCommandPath: "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
          }),
        });

        await fetch(`${providerServer.url}/api/provider-settings/detect`, {
          method: "POST",
        });

        const res = await fetch(`${providerServer.url}/api/provider-settings`);
        const body = (await json(res)) as Record<string, unknown>;
        assert.equal(
          body.codexCommandPath,
          "C:\\Users\\TIM\\.vscode\\extensions\\openai.chatgpt\\codex.exe",
        );
      } finally {
        await providerServer.close();
      }
    });

    it("reads, saves, detects, and tests provider settings", async () => {
      let detectionOptions: CodexCliDetectionOptions | undefined;
      let connectionOptions: CodexLocalConnectionTestOptions | undefined;
      const providerServer = await startServer(undefined, {
        codexCliDetection: {
          env: { PATH: "C:\\Tools" },
          platform: "win32",
          fileExists: (path: string) => path === "C:\\Tools\\codex.cmd",
        },
        testCodexLocalConnection: async (options: CodexLocalConnectionTestOptions) => {
          connectionOptions = options;
          return {
            status: {
              state: "connected",
              detected: true,
              checkedAt: "2026-06-18T04:00:00.000Z",
              message: "Fake connection ok",
            },
          };
        },
        detectCodexCliCommand: (options: CodexCliDetectionOptions) => {
          detectionOptions = options;
          return {
            detected: true,
            commandPath: "C:\\Tools\\codex.cmd",
            source: "path",
            status: {
              state: "detected",
              detected: true,
              checkedAt: null,
              message: "Fake detection ok",
            },
          };
        },
      });

      try {
        const initial = await fetch(`${providerServer.url}/api/provider-settings`).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
        assert.equal(initial.provider, "mock");

        const saved = await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex-subscription",
            codexCommandPath: "C:\\Manual\\codex.cmd",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        assert.equal(saved.provider, "codex-local");
        assert.equal(saved.modelLabel, "gpt-5-codex-subscription");

        const detected = await fetch(`${providerServer.url}/api/provider-settings/detect`, {
          method: "POST",
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        assert.equal(detected.commandPath, "C:\\Tools\\codex.cmd");
        assert.equal(detectionOptions?.manualPath, "C:\\Manual\\codex.cmd");

        const tested = await fetch(`${providerServer.url}/api/provider-settings/test`, {
          method: "POST",
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        assert.equal((tested.status as Record<string, unknown>).state, "connected");
        assert.equal(connectionOptions?.codexCommandPath, "C:\\Tools\\codex.cmd");
        assert.equal(connectionOptions?.modelLabel, "gpt-5-codex-subscription");
      } finally {
        await providerServer.close();
      }
    });

    it("returns sanitized selectable models from GET /api/provider-settings/models", async () => {
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Tools\\codex.cmd",
          source: "path",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message: "Codex CLI detected on PATH.",
          },
        }),
        loadCodexModelCatalog: async (options: CodexModelCatalogOptions) => {
          assert.equal(options.codexCommandPath, "C:\\Tools\\codex.cmd");
          assert.equal(options.source, "path");
          return {
            models: [
              { slug: "gpt-5-codex-mini", displayName: "GPT-5 Codex Mini", description: null, priority: 10 },
              { slug: "gpt-5-codex", displayName: "GPT-5 Codex", description: "Latest", priority: 20 },
            ],
            defaultModelSlug: "gpt-5-codex-mini",
            source: "path",
            status: { state: "available", checkedAt: "2026-06-18T06:00:00.000Z", message: null },
          };
        },
      });

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings/models`);
        assert.equal(res.status, 200);
        const body = (await json(res)) as Record<string, unknown>;
        assert.equal((body.status as Record<string, unknown>).state, "available");
        assert.equal(body.defaultModelSlug, "gpt-5-codex-mini");
        const models = body.models as Array<Record<string, unknown>>;
        assert.deepEqual(
          models.map((m) => m.slug),
          ["gpt-5-codex-mini", "gpt-5-codex"],
        );
      } finally {
        await providerServer.close();
      }
    });

    it("omits base instructions, prompts, hidden models, and credential material from model catalog responses", async () => {
      const forbiddenValues = [
        "BASE-INSTRUCTIONS-SECRET",
        "PROMPT-METADATA-SECRET",
        "hidden-internal-model",
        "catalog-access-token",
        "catalog-cookie",
        "sk-catalog-secret",
      ];
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Tools\\codex.cmd --api-key sk-catalog-secret",
          source: "path",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message: "Codex CLI detected on PATH.",
          },
        }),
        // The route maps only allowlisted fields, so even if a runner leaked raw
        // metadata into a model entry it would be dropped before the response.
        loadCodexModelCatalog: async () => ({
          models: [
            {
              slug: "gpt-5-codex",
              displayName: "GPT-5 Codex",
              description: "Safe description",
              priority: 1,
              // deliberately leaked extra fields that must not survive sanitization
              base_instructions: "BASE-INSTRUCTIONS-SECRET",
              prompt: "PROMPT-METADATA-SECRET",
              access_token: "catalog-access-token",
              cookie: "catalog-cookie",
            } as never,
          ],
          defaultModelSlug: "gpt-5-codex",
          source: "path",
          status: {
            state: "available",
            checkedAt: "2026-06-18T06:00:00.000Z",
            message: "loaded with sk-catalog-secret Authorization: Bearer catalog-bearer",
          },
        }),
      });

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings/models`);
        const body = (await json(res)) as Record<string, unknown>;
        assertDoesNotContainValues(body, forbiddenValues);
        const models = body.models as Array<Record<string, unknown>>;
        assert.deepEqual(Object.keys(models[0]).sort(), [
          "description",
          "displayName",
          "priority",
          "slug",
        ]);
        assert.equal((body.status as Record<string, unknown>).message?.toString().includes("sk-catalog-secret"), false);
      } finally {
        await providerServer.close();
      }
    });

    it("returns a sanitized fallback that permits manual/default setup when catalog lookup is unavailable", async () => {
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: false,
          commandPath: null,
          source: "none",
          status: {
            state: "not_found",
            detected: false,
            checkedAt: null,
            message: "Codex CLI was not found.",
          },
        }),
      });

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings/models`);
        assert.equal(res.status, 200);
        const body = (await json(res)) as Record<string, unknown>;
        assert.equal((body.status as Record<string, unknown>).state, "unavailable");
        assert.deepEqual(body.models, []);
        assert.equal(body.defaultModelSlug, null);
      } finally {
        await providerServer.close();
      }
    });

    it("returns a sanitized fallback when catalog discovery itself fails", async () => {
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Tools\\codex.cmd",
          source: "path",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message: "Codex CLI detected on PATH.",
          },
        }),
        loadCodexModelCatalog: async () => ({
          models: [],
          defaultModelSlug: null,
          source: "path",
          status: {
            state: "unavailable",
            checkedAt: "2026-06-18T06:00:00.000Z",
            message: "Codex CLI returned malformed model catalog output.",
          },
        }),
      });

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings/models`);
        assert.equal(res.status, 200);
        const body = (await json(res)) as Record<string, unknown>;
        assert.equal((body.status as Record<string, unknown>).state, "unavailable");
        assert.deepEqual(body.models, []);
        assert.equal(body.defaultModelSlug, null);
      } finally {
        await providerServer.close();
      }
    });

    it("does not expose credential material in settings, status, or connection test responses", async () => {
      const forbiddenValues = [
        "save-api-key",
        "save-token",
        "detect-api-key",
        "detect-bearer",
        "detect-cookie",
        "test-api-key",
        "test-bearer",
        "test-cookie",
      ];
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => ({
          detected: true,
          commandPath: "C:\\Tools\\codex.cmd --api-key detect-api-key",
          source: "manual",
          status: {
            state: "detected",
            detected: true,
            checkedAt: null,
            message:
              "detected with sk-detect-api-key Authorization: Bearer detect-bearer cookie=detect-cookie;",
          },
        }),
        testCodexLocalConnection: async () => ({
          status: {
            state: "command_failure",
            detected: true,
            checkedAt: "2026-06-18T05:00:00.000Z",
            message:
              "failed with sk-test-api-key Authorization: Bearer test-bearer cookie=test-cookie;",
          },
        }),
      });

      try {
        const saved = await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex-subscription",
            codexCommandPath: "C:\\Tools\\codex.cmd --api-key save-api-key --token save-token",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const statusAfterSave = await fetch(`${providerServer.url}/api/provider-settings`).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
        const detected = await fetch(`${providerServer.url}/api/provider-settings/detect`, {
          method: "POST",
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        const statusAfterDetect = await fetch(`${providerServer.url}/api/provider-settings`).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
        const tested = await fetch(`${providerServer.url}/api/provider-settings/test`, {
          method: "POST",
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        assertDoesNotContainValues(
          [saved, statusAfterSave, detected, statusAfterDetect, tested],
          forbiddenValues,
        );
      } finally {
        await providerServer.close();
      }
    });
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

    it("uses current saved Codex Local settings when starting a goal", { skip: process.platform === "win32" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-saved-provider-"));
      const capturePath = join(dir, "captured-saved-provider.json");
      const codexPath = createFakeCodexScript(dir, capturePath, "Saved Codex Local response");
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => detectedCodexResult(codexPath),
        codexCliProviderTimeoutMs: 10000,
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex-subscription",
            codexCommandPath: codexPath,
          }),
        });

        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Saved provider start",
            description: "uses persisted Codex Local settings",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(
          events.some(
            (e) =>
              e.type === "agent.message" &&
              e.message === "Saved Codex Local response" &&
              (e.data as Record<string, unknown>).provider === "codex-cli" &&
              (e.data as Record<string, unknown>).model === "gpt-5-codex-subscription",
          ),
        );

        const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
          args: string[];
          stdin: string;
        };
        // Legacy subscription label means "use Codex default" -> no --model.
        assert.equal(captured.args.includes("--model"), false);
        assert.match(captured.stdin, /Title: Saved provider start/);
      } finally {
        await providerServer.close();
      }
    });

    it("records an understandable default model marker when no model label is saved", { skip: process.platform === "win32" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-default-model-"));
      const capturePath = join(dir, "captured-default-model.json");
      const codexPath = createFakeCodexScript(dir, capturePath, "Default model response");
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => detectedCodexResult(codexPath),
        codexCliProviderTimeoutMs: 10000,
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "",
            codexCommandPath: codexPath,
          }),
        });

        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Default model start",
            description: "no model label saved",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(
          events.some(
            (e) =>
              e.type === "agent.message" &&
              (e.data as Record<string, unknown>).model === "codex-default",
          ),
        );

        // A blank label omits --model so Codex picks its own default.
        const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[] };
        assert.equal(captured.args.includes("--model"), false);
      } finally {
        await providerServer.close();
      }
    });

    it("uses explicitly saved mock settings instead of environment provider fallback", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-explicit-mock-"));
      const capturePath = join(dir, "captured-env-provider.json");
      const scriptPath = createFakeAgentScript(dir);
      const providerServer = await startServer({
        AUTO_AGENT_PROVIDER: "openai-local-agent",
        AUTO_AGENT_OPENAI_LOCAL_COMMAND: "node",
        AUTO_AGENT_OPENAI_LOCAL_ARGS_JSON: JSON.stringify([scriptPath, capturePath]),
        AUTO_AGENT_OPENAI_LOCAL_MODEL: "env-local-model",
        AUTO_AGENT_OPENAI_LOCAL_TIMEOUT_MS: "10000",
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "mock" }),
        });

        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Explicit mock start",
            description: "saved mock should override environment provider fallback",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(events.some((e) => e.type === "run.started" && e.message === "Mock run started"));
        assert.equal(existsSync(capturePath), false);
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
