import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../persistence/database.js";
import { createApp } from "./app.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../persistence/runtime-repositories.js";
import type { ClaudeCliDetectionOptions } from "../runtime/providers/claude/claude-cli-detection.js";
import type { CodexCliDetectionOptions } from "../runtime/providers/codex/codex-cli-detection.js";
import type { CodexLocalConnectionTestOptions } from "../runtime/providers/codex/codex-local-connection-test.js";
import type { CodexModelCatalogOptions } from "../runtime/providers/codex/codex-local-model-catalog.js";
import type { ProviderEnvironment } from "../runtime/providers/provider-config.js";
import { createMockRuntimeAdapter, type MockRuntimeAdapterControl } from "../runtime/mock/mock-runtime-adapter.js";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentSessionHandle,
} from "../domain/index.js";

function startServer(
  env?: ProviderEnvironment,
  appOptions?: Omit<Parameters<typeof createApp>[1], "env">,
) {
  const db = openDatabase({ path: ":memory:" });
  const app = createApp(db, { ...(appOptions ?? {}), ...(env ? { env } : {}) });
  const server = createServer(app);
  return new Promise<{ url: string; db: ReturnType<typeof openDatabase>; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      const close = () =>
        new Promise<void>((res, rej) =>
          server.close((err) => {
            db.close();
            return err ? rej(err) : res();
          }),
        );
      resolve({ url, db, close });
    });
  });
}

async function json(res: Response) {
  return res.json() as Promise<unknown>;
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
  if (process.platform === "win32") {
    const cmdPath = join(dir, "fake-codex.cmd");
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return cmdPath;
  }
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

/**
 * Writes an executable fake `claude` that captures argv + stdin to capturePath
 * and prints `response` to stdout, mirroring `claude --print --output-format
 * text`. Returned path is fed to the provider via injected detection.
 */
function createFakeClaudeScript(dir: string, capturePath: string, response: string): string {
  const scriptPath = join(dir, "fake-claude.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
  process.stdout.write(${JSON.stringify(response)});
});
`,
  );
  chmodSync(scriptPath, 0o755);
  if (process.platform === "win32") {
    const cmdPath = join(dir, "fake-claude.cmd");
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return cmdPath;
  }
  return scriptPath;
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

async function startManagedGoal(url: string, title: string) {
  const created = await fetch(`${url}/api/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description: "Exercise fixture-backed managed controls.",
    }),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

  const started = await fetch(`${url}/api/goals/${created.id}/start`, { method: "POST" });
  assert.equal(started.status, 200);
  return created;
}

async function waitForAgentSessionSnapshot(
  url: string,
  goalId: unknown,
  predicate: (snapshot: Record<string, unknown>) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await fetch(`${url}/api/goals/${goalId}/agent-session`).then(
      (r) => r.json() as Promise<Record<string, unknown>>,
    );
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for agent session snapshot");
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

    it("detects the provider supplied in the request body without changing saved mock settings", async () => {
      let manualPath: string | null | undefined;
      const providerServer = await startServer(undefined, {
        detectClaudeCliCommand: (options: ClaudeCliDetectionOptions) => {
          manualPath = options.manualPath;
          return {
            detected: true,
            commandPath: "C:\\Draft\\claude.cmd",
            source: "manual",
            status: {
              state: "detected",
              detected: true,
              checkedAt: null,
              message: "Claude draft detected.",
            },
          };
        },
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "mock" }),
        });

        const detected = await fetch(`${providerServer.url}/api/provider-settings/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "claude-local",
            claudeCommandPath: "C:\\Draft\\claude.cmd",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        assert.equal(manualPath, "C:\\Draft\\claude.cmd");
        assert.equal(detected.commandPath, "C:\\Draft\\claude.cmd");

        const saved = await fetch(`${providerServer.url}/api/provider-settings`).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
        assert.equal(saved.provider, "mock");
        assert.equal(saved.modelLabel, "mock-v1");
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

    it("persists a failed Codex Local connection test status", async () => {
      const providerServer = await startServer(undefined, {
        testCodexLocalConnection: async () => ({
          status: {
            state: "command_failure",
            detected: true,
            checkedAt: "2026-06-22T02:05:00.000Z",
            message: "Codex Local connection test failed: timed out",
          },
        }),
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex",
            codexCommandPath: "C:\\Tools\\codex.cmd",
          }),
        });

        const tested = await fetch(`${providerServer.url}/api/provider-settings/test`, {
          method: "POST",
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        assert.equal((tested.status as Record<string, unknown>).state, "command_failure");

        const saved = await fetch(`${providerServer.url}/api/provider-settings`).then(
          (r) => r.json() as Promise<Record<string, unknown>>,
        );
        assert.equal((saved.status as Record<string, unknown>).state, "command_failure");
        assert.equal(
          (saved.status as Record<string, unknown>).message,
          "Codex Local connection test failed: timed out",
        );
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

    it("uses Codex Local provider override from the start request", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-codex-override-"));
      const capturePath = join(dir, "captured-codex-override.json");
      const codexPath = createFakeCodexScript(dir, capturePath, "Codex override response");
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => detectedCodexResult(codexPath),
        codexCliProviderTimeoutMs: 10000,
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
            title: "Codex override start",
            description: "uses request provider override",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerOverride: {
              provider: "codex-local",
              modelLabel: "gpt5-4",
              codexCommandPath: codexPath,
            },
          }),
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(
          events.some(
            (e) =>
              e.type === "agent.message" &&
              e.message === "Codex override response" &&
              (e.data as Record<string, unknown>).provider === "codex-cli" &&
              (e.data as Record<string, unknown>).model === "gpt5-4",
          ),
        );

        const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[] };
        const modelIndex = captured.args.indexOf("--model");
        assert.equal(captured.args[modelIndex + 1], "gpt5-4");
      } finally {
        await providerServer.close();
      }
    });

    it("uses mock provider override even when saved settings point to Codex Local", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-mock-override-"));
      const capturePath = join(dir, "captured-mock-override.json");
      const codexPath = createFakeCodexScript(dir, capturePath, "Should not run");
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
            modelLabel: "saved-model",
            codexCommandPath: codexPath,
          }),
        });

        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Mock override start",
            description: "request mock should win over saved Codex",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerOverride: { provider: "mock" } }),
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(events.some((e) => e.type === "run.started" && e.message === "Mock run started"));
        assert.ok(events.some((e) => e.type === "run.started" && (e.data as Record<string, unknown>).provider === "mock"));
      } finally {
        await providerServer.close();
      }
    });

    it("uses Claude Local provider override from the start request", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-claude-override-"));
      const capturePath = join(dir, "captured-claude-override.json");
      const claudePath = createFakeClaudeScript(dir, capturePath, "Claude override response\n");
      const providerServer = await startServer(undefined, {
        detectClaudeCliCommand: () => detectedCodexResult(claudePath),
        claudeCliProviderTimeoutMs: 10000,
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
            title: "Claude override start",
            description: "uses request Claude provider override",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerOverride: {
              provider: "claude-local",
              modelLabel: "claude-sonnet-4-6",
              claudeCommandPath: claudePath,
            },
          }),
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(
          events.some(
            (e) =>
              e.type === "agent.message" &&
              e.message === "Claude override response" &&
              (e.data as Record<string, unknown>).provider === "claude-cli" &&
              (e.data as Record<string, unknown>).model === "claude-sonnet-4-6",
          ),
        );

        const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[] };
        const modelIndex = captured.args.indexOf("--model");
        assert.equal(captured.args[modelIndex + 1], "claude-sonnet-4-6");

        assert.ok(
          events.some((e) => e.type === "agent.progress" && e.message === "Claude override response"),
          "Claude CLI stdout must be captured as a durable agent.progress event",
        );
      } finally {
        await providerServer.close();
      }
    });

    it("does not persist override settings or expose credential material in start responses or events", async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-safe-override-"));
      const capturePath = join(dir, "captured-safe-override.json");
      const codexPath = createFakeCodexScript(dir, capturePath, "Safe override response");
      const providerServer = await startServer(undefined, {
        detectCodexCliCommand: () => detectedCodexResult(codexPath),
        codexCliProviderTimeoutMs: 10000,
      });
      const secrets = ["sk-start-secret", "secret-token", "secret-access-token"];

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
            title: "Credential safe override start",
            description: "override should not leak secrets",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerOverride: {
              provider: "codex-local",
              modelLabel: "gpt5-4",
              codexCommandPath: `${codexPath} --api-key sk-start-secret --token secret-token --access-token secret-access-token`,
            },
          }),
        });
        assert.equal(res.status, 200);
        assertDoesNotContainValues(await json(res), secrets);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assertDoesNotContainValues(events, secrets);

        const settings = (await fetch(`${providerServer.url}/api/provider-settings`).then(
          (r) => r.json(),
        )) as Record<string, unknown>;
        assert.equal(settings.provider, "mock");
        assert.equal(settings.modelLabel, "mock-v1");
        assertDoesNotContainValues(settings, secrets);
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

    it("starts a goal end-to-end with saved Claude Local settings", { skip: process.platform === "win32" }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "auto-agent-api-claude-"));
      const capturePath = join(dir, "captured-claude.json");
      const claudePath = createFakeClaudeScript(dir, capturePath, "Claude Local response\n");
      const providerServer = await startServer(undefined, {
        detectClaudeCliCommand: () => detectedCodexResult(claudePath),
        claudeCliProviderTimeoutMs: 10000,
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "claude-local",
            modelLabel: "claude-sonnet-4-6",
            claudeCommandPath: claudePath,
          }),
        });

        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Claude provider start",
            description: "uses persisted Claude Local settings",
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
              e.message === "Claude Local response" &&
              (e.data as Record<string, unknown>).provider === "claude-cli" &&
              (e.data as Record<string, unknown>).model === "claude-sonnet-4-6",
          ),
        );

        const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
          args: string[];
          stdin: string;
        };
        assert.ok(captured.args.includes("--print"));
        assert.match(captured.stdin, /Title: Claude provider start/);
        const modelIndex = captured.args.indexOf("--model");
        assert.equal(captured.args[modelIndex + 1], "claude-sonnet-4-6");
      } finally {
        await providerServer.close();
      }
    });

    it("uses explicitly saved mock settings instead of environment provider fallback", async () => {
      const providerServer = await startServer({
        AUTO_AGENT_PROVIDER: "openai-compatible",
        AUTO_AGENT_BASE_URL: "http://127.0.0.1:9/should-not-be-called",
        AUTO_AGENT_API_KEY: "env-api-secret",
        AUTO_AGENT_MODEL: "env-model",
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
      } finally {
        await providerServer.close();
      }
    });

    it("routes Codex Local starts through a registered managed session adapter", async () => {
      const providerServer = await startServer(undefined, {
        agentRuntimeAdapters: {
          "codex-local": createCompletingRuntimeAdapter("codex-local"),
        },
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex",
            codexCommandPath: "C:\\Tools\\codex.cmd",
          }),
        });

        const created = await fetch(`${providerServer.url}/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Managed Codex start",
            description: "routes through session manager",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.ok(events.some((event) => event.type === "run.started" && event.message === "Managed agent session started"));
        assert.ok(events.some((event) => event.type === "agent.progress" && event.message === "Managed adapter progress"));

        const snapshot = (await fetch(`${providerServer.url}/api/goals/${created.id}/agent-session`).then(
          (r) => r.json(),
        )) as Record<string, Record<string, unknown>>;
        assert.equal(snapshot.session?.providerId, "codex-local");
        assert.equal(snapshot.session?.lifecycleState, "completed");
      } finally {
        await providerServer.close();
      }
    });

    it("completes a direct mock work item within configured step bounds", async () => {
      const providerServer = await startServer(undefined, { agentLoopMaxSteps: 1 });

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
            title: "Bounded mock start",
            description: "direct implementation closes after one assigned step",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        assert.equal(events.filter((candidate) => candidate.type === "step.completed").length, 1);
        assert.equal(events.some((candidate) => candidate.type === "gate.voted"), false);
      } finally {
        await providerServer.close();
      }
    });

    it("wires configured scope assessment bounds into the mock runtime", async () => {
      const providerServer = await startServer(undefined, {
        agentLoopMaxScopeAssessmentAttempts: 1,
        agentLoopMaxScopeRefinementRounds: 3,
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
            title: "scope API wiring",
            description: "exercise configured scope assessment bounds",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        const scopeVote = events.find((event) => event.type === "scope.voted");
        assert.equal((scopeVote?.data as Record<string, unknown>).decision, false);
        assert.equal(events.filter((event) => event.type === "agent.decision").length, 1);
      } finally {
        await providerServer.close();
      }
    });

    it("records a full iterative mock loop timeline through the API", async () => {
      const providerServer = await startServer();

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
            title: "Mock iterative API",
            description: "assert the full loop timeline",
          }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);

        const res = await fetch(`${providerServer.url}/api/goals/${created.id}/start`, {
          method: "POST",
        });
        assert.equal(res.status, 200);

        const { events } = await waitForEvent(providerServer.url, created.id, "goal.completed");
        const types = events.map((event) => event.type);
        assert.equal(types.filter((type) => type === "step.completed").length, 1);
        assert.deepEqual(
          events
            .filter((event) => event.type === "agent.decision")
            .map((event) => (event.data as Record<string, unknown>).nextStep),
          ["Analyze goal"],
        );
        assert.deepEqual(
          events.filter((event) => event.type === "agent.message").map((event) => event.message),
          ["Completed: Analyze goal"],
        );
        assert.equal(events.some((event) => event.type === "gate.voted"), false);
        assert.equal(events.some((event) => event.type === "scope.voted"), false);
        assert.equal(types.at(-1), "goal.completed");
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

  describe("Agent session control API", () => {
    it("returns a durable session snapshot for a goal", async () => {
      const providerServer = await startServer();

      try {
        const { goal, session, approval, childRequest } = seedManagedSession(providerServer.db);

        const res = await fetch(`${providerServer.url}/api/goals/${goal.id}/agent-session`);
        assert.equal(res.status, 200);
        const body = (await json(res)) as Record<string, unknown>;

        assert.equal((body.session as Record<string, unknown>).id, session.id);
        assert.equal((body.session as Record<string, unknown>).lifecycleState, "waiting_approval");
        assert.deepEqual(
          ((body.approvals as Array<Record<string, unknown>>)[0]).id,
          approval.id,
        );
        assert.deepEqual(
          ((body.childSessionRequests as Array<Record<string, unknown>>)[0]).id,
          childRequest.id,
        );
      } finally {
        await providerServer.close();
      }
    });

    it("returns worktree metadata and review merge outcome read models", async () => {
      const providerServer = await startServer();

      try {
        const { goal, childSession, delegation } = seedManagedSession(providerServer.db, {
          includeReviewMergeEvidence: true,
        });

        const res = await fetch(`${providerServer.url}/api/goals/${goal.id}/agent-session`);
        assert.equal(res.status, 200);
        const body = (await json(res)) as Record<string, unknown>;

        assert.equal(
          ((body.sessions as Array<Record<string, unknown>>).find((item) => item.id === childSession?.id)
            ?.worktree as Record<string, unknown>)?.label,
          "child-session",
        );
        assert.equal(
          ((body.mergeOutcomes as Array<Record<string, unknown>>)[0]).delegationRequestId,
          delegation?.id,
        );
        assert.equal(
          ((body.mergeOutcomes as Array<Record<string, unknown>>)[0]).outcome,
          "test_failed_reverted",
        );
      } finally {
        await providerServer.close();
      }
    });

    it("approves rejects and cancels managed sessions through backend actions", async () => {
      const providerServer = await startServer();

      try {
        const { session, approval } = seedManagedSession(providerServer.db);

        const approved = await fetch(
          `${providerServer.url}/api/agent-sessions/${session.id}/approvals/${approval.id}/approve`,
          { method: "POST" },
        );
        assert.equal(approved.status, 200);
        assert.equal(((await json(approved)) as Record<string, unknown>).status, "approved");

        const duplicateReject = await fetch(
          `${providerServer.url}/api/agent-sessions/${session.id}/approvals/${approval.id}/reject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "too late" }),
          },
        );
        assert.equal(duplicateReject.status, 200);
        assert.equal(((await json(duplicateReject)) as Record<string, unknown>).status, "approved");

        const cancelled = await fetch(`${providerServer.url}/api/agent-sessions/${session.id}/cancel`, {
          method: "POST",
        });
        assert.equal(cancelled.status, 200);
        assert.equal(((await json(cancelled)) as Record<string, unknown>).lifecycleState, "cancelled");
      } finally {
        await providerServer.close();
      }
    });

    it("forwards fixture-backed approve reject and cancel controls to an active managed adapter once", async () => {
      const controls: MockRuntimeAdapterControl[] = [];
      const providerServer = await startServer(undefined, {
        agentRuntimeAdapters: {
          "codex-local": createMockRuntimeAdapter({
            pauseAfterApproval: true,
            onControl(control) {
              controls.push(control);
            },
          }),
        },
      });

      try {
        await fetch(`${providerServer.url}/api/provider-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex-local",
            modelLabel: "gpt-5-codex",
            codexCommandPath: "C:\\Tools\\codex.cmd",
          }),
        });

        const approvedGoal = await startManagedGoal(providerServer.url, "Approve through fixture");
        const approvedSnapshot = await waitForAgentSessionSnapshot(
          providerServer.url,
          approvedGoal.id,
          (snapshot) => Array.isArray(snapshot.approvals) && snapshot.approvals.length > 0,
        );
        const approvedSession = approvedSnapshot.session as Record<string, unknown>;
        const approval = (approvedSnapshot.approvals as Array<Record<string, unknown>>)[0]!;

        const approved = await fetch(
          `${providerServer.url}/api/agent-sessions/${approvedSession.id}/approvals/${approval.id}/approve`,
          { method: "POST" },
        );
        assert.equal(approved.status, 200);
        await fetch(`${providerServer.url}/api/agent-sessions/${approvedSession.id}/approvals/${approval.id}/approve`, {
          method: "POST",
        });
        await fetch(`${providerServer.url}/api/agent-sessions/${approvedSession.id}/cancel`, { method: "POST" });
        await fetch(`${providerServer.url}/api/agent-sessions/${approvedSession.id}/cancel`, { method: "POST" });

        const rejectedGoal = await startManagedGoal(providerServer.url, "Reject through fixture");
        const rejectedSnapshot = await waitForAgentSessionSnapshot(
          providerServer.url,
          rejectedGoal.id,
          (snapshot) => Array.isArray(snapshot.approvals) && snapshot.approvals.length > 0,
        );
        const rejectedSession = rejectedSnapshot.session as Record<string, unknown>;
        const rejection = (rejectedSnapshot.approvals as Array<Record<string, unknown>>)[0]!;

        const rejected = await fetch(
          `${providerServer.url}/api/agent-sessions/${rejectedSession.id}/approvals/${rejection.id}/reject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "fixture rejection" }),
          },
        );
        assert.equal(rejected.status, 200);
        await fetch(`${providerServer.url}/api/agent-sessions/${rejectedSession.id}/approvals/${rejection.id}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "duplicate" }),
        });
        await fetch(`${providerServer.url}/api/agent-sessions/${rejectedSession.id}/cancel`, { method: "POST" });

        assert.deepEqual(
          controls.map((control) => control.type),
          ["approve", "cancel", "reject", "cancel"],
        );
      } finally {
        await providerServer.close();
      }
    });

    it("returns provider runtime capabilities without credential material", async () => {
      const providerServer = await startServer();

      try {
        const res = await fetch(`${providerServer.url}/api/provider-settings/runtime-capabilities?provider=codex-local`);
        assert.equal(res.status, 200);
        const body = (await json(res)) as Record<string, unknown>;

        assert.equal(body.provider, "codex-local");
        assert.equal((body.capabilities as Record<string, unknown>).eventStreaming, true);
        assert.equal((body.capabilities as Record<string, unknown>).approval, false);
        assert.equal(JSON.stringify(body).includes("token"), false);
        assert.equal(JSON.stringify(body).includes("api-key"), false);
      } finally {
        await providerServer.close();
      }
    });

    it("omits credential material from session snapshots and control responses", async () => {
      const providerServer = await startServer();
      const secrets = ["snapshot-secret", "command-secret", "child-secret", "capability-secret"];

      try {
        const { goal, session, approval } = seedManagedSession(providerServer.db, {
          capabilityReason: "Authorization: Bearer capability-secret",
          approvalSummary: "Run command with token=snapshot-secret",
          safeCommand: "npm.cmd test --token command-secret",
          childPromptSummary: "Review with OPENAI_API_KEY=child-secret",
        });

        const snapshot = await fetch(`${providerServer.url}/api/goals/${goal.id}/agent-session`).then(
          (res) => res.json(),
        );
        assertDoesNotContainValues(snapshot, secrets);

        const approved = await fetch(
          `${providerServer.url}/api/agent-sessions/${session.id}/approvals/${approval.id}/approve`,
          { method: "POST" },
        ).then((res) => res.json());
        assertDoesNotContainValues(approved, secrets);
      } finally {
        await providerServer.close();
      }
    });
  });
});

interface SeedManagedSessionOptions {
  capabilityReason?: string;
  approvalSummary?: string;
  safeCommand?: string;
  childPromptSummary?: string;
  includeReviewMergeEvidence?: boolean;
}

function createCompletingRuntimeAdapter(providerId: string): AgentRuntimeAdapter {
  return {
    providerId,
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: false,
      };
    },
    async startSession(input) {
      const events: AgentRuntimeEvent[] = [
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Managed adapter progress",
          occurredAt: "2026-06-26T00:00:01.000Z",
          metadata: { providerId, modelLabel: input.modelLabel },
        },
        {
          type: "session.completed",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Managed adapter completed",
          occurredAt: "2026-06-26T00:00:02.000Z",
          metadata: { providerId, modelLabel: input.modelLabel },
        },
      ];
      return createTestSessionHandle(input.sessionId, events);
    },
  };
}

function createTestSessionHandle(sessionId: string, events: AgentRuntimeEvent[]): AgentSessionHandle {
  return {
    sessionId,
    capabilities: {
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
    async *events() {
      for (const event of events) yield event;
    },
    async send() {},
    async approve() {},
    async reject() {},
    async cancel() {},
  };
}

function seedManagedSession(
  db: ReturnType<typeof openDatabase>,
  options: SeedManagedSessionOptions = {},
) {
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const sessions = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Managed API goal",
    description: "Exercise session control API.",
  });
  const run = runRepo.create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const session = sessions.createSession({
    goalId: goal.id,
    runId: run.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "waiting_approval",
    capabilities: {
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: false,
      unsupportedReasons: { approval: options.capabilityReason ?? "Codex exec mode cannot resume approvals." },
    },
  });
  const command = sessions.recordCommand({
    sessionId: session.id,
    status: "pending",
    safeCommand: options.safeCommand ?? "npm.cmd test",
    cwd: null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    diagnostics: null,
  });
  const approval = sessions.createApprovalRequest({
    sessionId: session.id,
    commandId: command.id,
    safeSummary: options.approvalSummary ?? "Run tests",
  });
  const childRequest = sessions.recordChildSessionRequest({
    parentSessionId: session.id,
    childRole: "reviewer",
    promptSummary: options.childPromptSummary ?? "Review implementation.",
    status: "unsupported",
    safeReason: "Child-session scheduling is not enabled.",
  });
  let childSession = null;
  let delegation = null;
  if (options.includeReviewMergeEvidence) {
    childSession = sessions.createSession({
      goalId: goal.id,
      runId: run.id,
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      lifecycleState: "completed",
      capabilities: {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: false,
      },
      parent: { sessionId: session.id },
      worktree: {
        label: "child-session",
        path: "C:\\Users\\TIM\\.codex\\auth-cache\\child-session",
      },
    });
    delegation = sessions.createDelegationRequest({
      parentSessionId: session.id,
      role: "review_merge",
      promptSummary: "Review worker output.",
    });
    sessions.acceptDelegationRequest(delegation.id);
    sessions.startDelegationRequest(delegation.id, childSession.id);
    delegation = sessions.completeDelegationRequest(delegation.id, {
      kind: "success",
      safeSummary: "Review merge completed.",
    });
    createEventRepository(db).create({
      goalId: goal.id,
      runId: run.id,
      type: "agent.progress",
      message: "Fixed review-merge test failed; workspace revert verified.",
      data: {
        runtimeEventType: "review_merge.apply_outcome",
        delegationRequestId: delegation.id,
        childSessionId: childSession.id,
        reviewMergeOutcome: "test_failed_reverted",
        diffSummary: "1 file changed.",
        safeSummary: "Fixed review-merge test failed; workspace revert verified.",
        fixedTest: { command: "npm test", exitCode: 1, outputSummary: "failed tests" },
        revertEvidence: { verified: true, summary: "Workspace reverted to pre-merge checkpoint." },
      },
    });
  }

  return { goal, run, session, approval, childRequest, childSession, delegation };
}
