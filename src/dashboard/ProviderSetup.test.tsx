import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ProviderSetupPanel,
  saveProviderSettingsWithOptionalCodexTest,
} from "./ProviderSetup.js";
import type {
  CodexModelCatalogResult,
  ProviderConnectionState,
  ProviderSettings,
} from "./api.js";

test("provider setup panel renders Codex Local controls", () => {
  const html = renderToStaticMarkup(
    <ProviderSetupPanel
      settings={{
        provider: "codex-local",
        modelLabel: "gpt-5-codex-subscription",
        codexCommandPath: "C:\\Tools\\codex.cmd",
        status: {
          state: "detected",
          detected: true,
          checkedAt: null,
          message: "Detected",
        },
      }}
      busy={null}
      error={null}
      modelCatalog={null}
      catalogBusy={false}
      draftProvider="codex-local"
      modelLabel="gpt-5-codex-subscription"
      codexCommandPath="C:\\Tools\\codex.cmd"
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );

  assert.match(html, /Provider setup/);
  assert.match(html, /Codex Local/);
  assert.match(html, /Model/);
  assert.match(html, /Command path/);
  assert.match(html, /Detect/);
  assert.match(html, /Test connection/);
});

test("provider setup panel hides Codex controls for mock provider", () => {
  const html = renderToStaticMarkup(
    <ProviderSetupPanel
      settings={{
        provider: "mock",
        modelLabel: "mock-v1",
        codexCommandPath: null,
        status: {
          state: "not_checked",
          detected: false,
          checkedAt: null,
          message: null,
        },
      }}
      busy={null}
      error={null}
      modelCatalog={null}
      catalogBusy={false}
      draftProvider="mock"
      modelLabel="mock-v1"
      codexCommandPath=""
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );

  assert.match(html, /Mock/);
  assert.doesNotMatch(html, /Command path/);
  assert.doesNotMatch(html, /Test connection/);
});

test("provider setup panel renders clear status states", () => {
  const cases: Array<[ProviderConnectionState, string]> = [
    ["detected", "Codex CLI detected"],
    ["not_found", "Codex CLI not found"],
    ["connected", "Codex Local connected"],
    ["login_required", "Codex login required"],
    ["network_failure", "Network failure"],
    ["command_failure", "Command failed"],
  ];

  for (const [state, label] of cases) {
    const html = renderProviderSetupPanel({
      provider: "codex-local",
      modelLabel: "gpt-5-codex-subscription",
      codexCommandPath: "C:\\Tools\\codex.cmd",
      status: {
        state,
        detected: state !== "not_found",
        checkedAt: "2026-06-18T04:00:00.000Z",
        message: null,
      },
    });

    assert.match(html, new RegExp(label));
  }
});

test("provider setup panel shows connected status without credential material", () => {
  const html = renderProviderSetupPanel({
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Tools\\codex.cmd",
    status: {
      state: "connected",
      detected: true,
      checkedAt: "2026-06-18T04:00:00.000Z",
      message:
        "connected with sk-dashboard-secret Authorization: Bearer dashboard-token cookie=dashboard-cookie; --api-key dashboard-api-key",
    },
  });

  assert.match(html, /Codex Local connected/);
  assert.match(html, /\[redacted\]/);
  for (const forbidden of [
    "sk-dashboard-secret",
    "dashboard-token",
    "dashboard-cookie",
    "dashboard-api-key",
  ]) {
    assert.equal(html.includes(forbidden), false);
  }
});

test("provider setup panel renders catalog models as picker options", () => {
  const html = renderCatalogPanel(
    {
      models: [
        { slug: "gpt-5-codex-mini", displayName: "GPT-5 Codex Mini", description: null, priority: 10 },
        { slug: "gpt-5-codex", displayName: "GPT-5 Codex", description: "Latest", priority: 20 },
      ],
      defaultModelSlug: "gpt-5-codex-mini",
      source: "path",
      status: { state: "available", checkedAt: null, message: null },
    },
    { modelLabel: "gpt-5-codex" },
  );

  assert.match(html, /Codex CLI default/);
  assert.match(html, /value="gpt-5-codex-mini"/);
  assert.match(html, /GPT-5 Codex Mini/);
  assert.match(html, /value="gpt-5-codex"/);
  assert.match(html, /2 models available/);
  // The currently selected model slug is reflected as the chosen option.
  assert.match(html, /<option value="gpt-5-codex" selected="">/);
});

test("provider setup panel shows the failure error and raw CLI detail without a manual fallback", () => {
  const html = renderCatalogPanel({
    models: [],
    defaultModelSlug: null,
    source: "path",
    status: {
      state: "unavailable",
      checkedAt: null,
      message: "Codex CLI returned malformed model catalog output.",
      detail: "RAW-CODEX-DEBUG-OUTPUT exit code 1",
    },
  });

  assert.match(html, /Model catalog lookup failed/);
  assert.match(html, /Codex CLI returned malformed model catalog output/);
  // The raw CLI output is shown for debugging.
  assert.match(html, /RAW-CODEX-DEBUG-OUTPUT exit code 1/);
  // No manual entry / Codex default fallback is offered on failure.
  assert.doesNotMatch(html, /placeholder="Codex CLI default"/);
  assert.doesNotMatch(html, /Enter model manually/);
});

test("provider setup panel surfaces a fetch failure as an error with no fallback", () => {
  const html = renderCatalogPanel(null, { modelLabel: "" });

  assert.match(html, /Model catalog lookup failed/);
  assert.doesNotMatch(html, /placeholder="Codex CLI default"/);
});

test("provider setup panel shows an empty-state message without a manual fallback", () => {
  const html = renderCatalogPanel({
    models: [],
    defaultModelSlug: null,
    source: "path",
    status: { state: "empty", checkedAt: null, message: null },
  });

  assert.match(html, /No selectable models were returned/);
  assert.doesNotMatch(html, /placeholder="Codex CLI default"/);
});

test("provider setup panel does not display raw catalog metadata or status messages", () => {
  const html = renderCatalogPanel(
    {
      models: [
        {
          slug: "gpt-5-codex",
          displayName: "GPT-5 Codex",
          description: "DESCRIPTION-RAW-METADATA",
          priority: 1,
        },
      ],
      defaultModelSlug: "gpt-5-codex",
      source: "path",
      status: {
        state: "available",
        checkedAt: null,
        message: "STATUS-RAW-MESSAGE sk-catalog-secret",
      },
    },
    { modelLabel: "gpt-5-codex" },
  );

  assert.equal(html.includes("DESCRIPTION-RAW-METADATA"), false);
  assert.equal(html.includes("STATUS-RAW-MESSAGE"), false);
  assert.equal(html.includes("sk-catalog-secret"), false);
});

function renderCatalogPanel(
  modelCatalog: CodexModelCatalogResult | null,
  overrides?: { modelLabel?: string },
) {
  return renderToStaticMarkup(
    <ProviderSetupPanel
      settings={{
        provider: "codex-local",
        modelLabel: overrides?.modelLabel ?? "",
        codexCommandPath: "C:\\Tools\\codex.cmd",
        status: { state: "detected", detected: true, checkedAt: null, message: null },
      }}
      busy={null}
      error={null}
      modelCatalog={modelCatalog}
      catalogBusy={false}
      draftProvider="codex-local"
      modelLabel={overrides?.modelLabel ?? ""}
      codexCommandPath="C:\\Tools\\codex.cmd"
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );
}

function renderProviderSetupPanel(settings: ProviderSettings) {
  return renderToStaticMarkup(
    <ProviderSetupPanel
      settings={settings}
      busy={null}
      error={null}
      modelCatalog={null}
      catalogBusy={false}
      draftProvider={settings.provider}
      modelLabel={settings.modelLabel}
      codexCommandPath={settings.provider === "codex-local" ? settings.codexCommandPath ?? "" : ""}
      claudeCommandPath={
        settings.provider === "claude-local" ? settings.claudeCommandPath ?? "" : ""
      }
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onClaudeCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );
}

test("provider setup panel renders Claude Local controls without a model catalog or test button", () => {
  const html = renderProviderSetupPanel({
    provider: "claude-local",
    modelLabel: "claude-sonnet-4-6",
    claudeCommandPath: "/home/u/.local/bin/claude",
    status: { state: "detected", detected: true, checkedAt: null, message: "Detected" },
  });

  assert.match(html, /Claude Local/);
  assert.match(html, /Command path/);
  assert.match(html, /Detect/);
  assert.match(html, /Claude CLI detected/);
  // Deferred for claude-local: no connection test and no model catalog picker.
  assert.doesNotMatch(html, /Test connection/);
  assert.doesNotMatch(html, /Refresh models/);
});

test("saving Codex Local settings triggers a connection test after save succeeds", async () => {
  const calls: string[] = [];

  await saveProviderSettingsWithOptionalCodexTest(
    {
      provider: "codex-local",
      modelLabel: "gpt-5-codex",
      codexCommandPath: "C:\\Tools\\codex.cmd",
    },
    {
      save: async () => {
        calls.push("save");
        return {
          provider: "codex-local",
          modelLabel: "gpt-5-codex",
          codexCommandPath: "C:\\Tools\\codex.cmd",
          status: { state: "not_checked", detected: false, checkedAt: null, message: null },
        };
      },
      testConnection: async () => {
        calls.push("test");
        return {
          status: {
            state: "connected",
            detected: true,
            checkedAt: "2026-06-22T01:52:33.000Z",
            message: "Codex Local connection test succeeded.",
          },
        };
      },
    },
  );

  assert.deepEqual(calls, ["save", "test"]);
});

test("auto-testing saved Codex settings has a distinct visible state and keeps retry visible", () => {
  const html = renderToStaticMarkup(
    <ProviderSetupPanel
      settings={{
        provider: "codex-local",
        modelLabel: "gpt-5-codex",
        codexCommandPath: "C:\\Tools\\codex.cmd",
        status: { state: "not_checked", detected: false, checkedAt: null, message: null },
      }}
      busy="auto-test"
      error={null}
      modelCatalog={{
        models: [
          { slug: "gpt-5-codex", displayName: "GPT-5 Codex", description: null, priority: 1 },
        ],
        defaultModelSlug: "gpt-5-codex",
        source: "manual",
        status: { state: "available", checkedAt: null, message: null },
      }}
      catalogBusy={false}
      draftProvider="codex-local"
      modelLabel="gpt-5-codex"
      codexCommandPath="C:\\Tools\\codex.cmd"
      claudeCommandPath=""
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onClaudeCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );

  assert.match(html, /Testing saved model/);
  assert.match(html, /Test connection/);
  assert.doesNotMatch(html, /Saving\.\.\./);
});

test("auto-test result updates the rendered provider status", async () => {
  const applied: ProviderSettings[] = [];

  await saveProviderSettingsWithOptionalCodexTest(
    {
      provider: "codex-local",
      modelLabel: "gpt-5-codex",
      codexCommandPath: "C:\\Tools\\codex.cmd",
    },
    {
      save: async () => ({
        provider: "codex-local",
        modelLabel: "gpt-5-codex",
        codexCommandPath: "C:\\Tools\\codex.cmd",
        status: { state: "not_checked", detected: false, checkedAt: null, message: null },
      }),
      testConnection: async () => ({
        status: {
          state: "connected",
          detected: true,
          checkedAt: "2026-06-22T01:52:33.000Z",
          message: "Codex Local connection test succeeded.",
        },
      }),
      onSaved: (settings) => applied.push(settings),
    },
  );

  assert.deepEqual(
    applied.map((settings) => settings.status.state),
    ["not_checked", "connected"],
  );
});
