import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  detectCodexCli,
  getProviderSettings,
  saveProviderSettings,
  startGoal,
  testCodexLocalConnection,
} from "./api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reads provider settings from dashboard API", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
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
  };

  const settings = await getProviderSettings();

  assert.equal(calls[0].url, "/api/provider-settings");
  assert.equal(settings.provider, "mock");
  assert.equal(settings.status.state, "not_checked");
});

test("saves Codex Local provider settings through dashboard API", async () => {
  let capturedBody: unknown;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({
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
  };

  const saved = await saveProviderSettings({
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Tools\\codex.cmd",
  });

  assert.deepEqual(capturedBody, {
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Tools\\codex.cmd",
  });
  assert.equal(saved.provider, "codex-local");
});

test("starts a goal with a provider override through dashboard API", async () => {
  let capturedUrl = "";
  let capturedMethod: string | undefined;
  let capturedBody: unknown;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = init?.method;
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ ok: true });
  };

  await startGoal("goal-1", {
    providerOverride: {
      provider: "codex-local",
      modelLabel: "gpt5-4",
      codexCommandPath: "C:\\Tools\\codex.cmd",
    },
  });

  assert.equal(capturedUrl, "/api/goals/goal-1/start");
  assert.equal(capturedMethod, "POST");
  assert.deepEqual(capturedBody, {
    providerOverride: {
      provider: "codex-local",
      modelLabel: "gpt5-4",
      codexCommandPath: "C:\\Tools\\codex.cmd",
    },
  });
});

test("starts a goal without a body when no provider override is supplied", async () => {
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({ ok: true });
  };

  await startGoal("goal-1");

  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.body, undefined);
});

test("detects and tests Codex Local connection through dashboard API", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });

    if (String(input).endsWith("/detect")) {
      return jsonResponse({
        detected: true,
        commandPath: "C:\\Tools\\codex.cmd",
        source: "path",
        status: {
          state: "detected",
          detected: true,
          checkedAt: null,
          message: "Detected",
        },
      });
    }

    return jsonResponse({
      status: {
        state: "connected",
        detected: true,
        checkedAt: "2026-06-18T04:00:00.000Z",
        message: "Connected",
      },
    });
  };

  const detected = await detectCodexCli();
  const tested = await testCodexLocalConnection();

  assert.deepEqual(
    calls.map((call) => [call.url, call.init?.method]),
    [
      ["/api/provider-settings/detect", "POST"],
      ["/api/provider-settings/test", "POST"],
    ],
  );
  assert.equal(detected.commandPath, "C:\\Tools\\codex.cmd");
  assert.equal(tested.status.state, "connected");
});

test("detects the currently selected provider draft through dashboard API", async () => {
  let capturedBody: unknown;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({
      detected: true,
      commandPath: "C:\\Tools\\claude.cmd",
      source: "manual",
      status: {
        state: "detected",
        detected: true,
        checkedAt: null,
        message: "Detected",
      },
    });
  };

  await detectCodexCli({
    provider: "claude-local",
    claudeCommandPath: "C:\\Tools\\claude.cmd",
  });

  assert.deepEqual(capturedBody, {
    provider: "claude-local",
    claudeCommandPath: "C:\\Tools\\claude.cmd",
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
