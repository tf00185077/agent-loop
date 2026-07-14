import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ProviderSetupPanel,
  toStartGoalProviderOverride,
} from "./ProviderSetup.js";
import type {
  CodexModelCatalogResult,
  ProviderConnectionState,
  ProviderSettings,
} from "./api.js";

test("provider setup panel renders Codex Local controls with troubleshooting actions de-emphasized", () => {
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

  assert.match(html, /Provider setup/);
  assert.match(html, /Codex Local/);
  assert.match(html, /Model/);
  assert.match(html, /Troubleshooting/);
  assert.match(html, /Use these checks only when a Codex run cannot start/);
  assert.match(html, /<details[^>]*>/);
  assert.match(html, /Command path/);
  assert.match(html, /Save as default/);
  assert.match(html, /Detect/);
  assert.match(html, /Test connection/);
  assert.match(html, /Refresh models/);
  assert.equal(html.includes(">Save</button>"), false);
  assert.ok(
    html.indexOf("Troubleshooting") < html.indexOf("Command path"),
    "Command path should be inside the troubleshooting area, after its summary",
  );
  assert.ok(
    html.indexOf("Troubleshooting") < html.indexOf("Save as default"),
    "Save as default should be inside the troubleshooting area, after its summary",
  );
});

test("builds a start override from unsaved Codex Local draft settings", () => {
  assert.deepEqual(
    toStartGoalProviderOverride({
      draftProvider: "codex-local",
      modelLabel: "gpt5-4",
      codexCommandPath: "C:\\Tools\\codex.cmd",
      claudeCommandPath: "",
    }),
    {
      provider: "codex-local",
      modelLabel: "gpt5-4",
      codexCommandPath: "C:\\Tools\\codex.cmd",
    },
  );
});

test("builds a start override from unsaved mock draft settings", () => {
  assert.deepEqual(
    toStartGoalProviderOverride({
      draftProvider: "mock",
      modelLabel: "mock-v1",
      codexCommandPath: "C:\\Tools\\codex.cmd",
      claudeCommandPath: "",
    }),
    { provider: "mock" },
  );
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

test("provider setup panel shows catalog failure detail while still allowing manual model entry", () => {
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
  assert.match(html, /placeholder="Codex CLI default or model slug"/);
  assert.match(html, /You can still enter a model manually/);
});

test("provider setup panel surfaces a fetch failure with manual model entry", () => {
  const html = renderCatalogPanel(null, { modelLabel: "" });

  assert.match(html, /Model catalog lookup failed/);
  assert.match(html, /placeholder="Codex CLI default or model slug"/);
});

test("provider setup panel shows an empty-state message with manual model entry", () => {
  const html = renderCatalogPanel({
    models: [],
    defaultModelSlug: null,
    source: "path",
    status: { state: "empty", checkedAt: null, message: null },
  });

  assert.match(html, /No selectable models were returned/);
  assert.match(html, /placeholder="Codex CLI default or model slug"/);
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

test("provider setup panel renders role assignment controls", () => {
  const html = renderToStaticMarkup(
    <ProviderSetupPanel
      settings={{
        provider: "codex-local",
        modelLabel: "gpt-5.5",
        codexCommandPath: "C:\\Tools\\codex.exe",
        status: { state: "detected", detected: true, checkedAt: null, message: null },
      }}
      busy={null}
      error={null}
      modelCatalog={null}
      catalogBusy={false}
      draftProvider="codex-local"
      modelLabel="gpt-5.5"
      codexCommandPath="C:\\Tools\\codex.exe"
      roleAssignments={{
        worker: { provider: "claude-local", modelLabel: "claude-sonnet-4", commandPath: null },
      }}
      onRoleAssignmentsChange={() => undefined}
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );

  assert.match(html, /Child agent roles/);
  assert.match(html, /Worker \(implementation\)/);
  assert.match(html, /Spec writer/);
  assert.match(html, /Review merge/);
  assert.match(html, /Integrator \(conflict recovery\)/);
  assert.match(html, /Inherit goal provider/);
  // The assigned worker row exposes model and command-path fields.
  assert.match(html, /aria-label="Worker \(implementation\) model"/);
  assert.match(html, /value="claude-sonnet-4"/);
  assert.match(html, /Save role assignments/);
  // Unassigned roles show only the provider picker.
  assert.doesNotMatch(html, /aria-label="Spec writer model"/);
});

test("provider setup panel hides the role save button when nothing is assigned", () => {
  const html = renderProviderSetupPanel({
    provider: "codex-local",
    modelLabel: "gpt-5.5",
    codexCommandPath: "C:\\Tools\\codex.exe",
    status: { state: "detected", detected: true, checkedAt: null, message: null },
  });

  assert.match(html, /Child agent roles/);
  assert.doesNotMatch(html, /Save role assignments/);
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

test("Codex troubleshooting keeps manual checks available without making them primary", () => {
  const html = renderToStaticMarkup(
    <ProviderSetupPanel
      settings={{
        provider: "codex-local",
        modelLabel: "gpt-5-codex",
        codexCommandPath: "C:\\Tools\\codex.cmd",
        status: { state: "not_checked", detected: false, checkedAt: null, message: null },
      }}
      busy={null}
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

  assert.match(html, /Troubleshooting/);
  assert.match(html, /Use these checks only when a Codex run cannot start/);
  assert.match(html, /Test connection/);
  assert.match(html, /Refresh models/);
  assert.match(html, /Save as default/);
});
