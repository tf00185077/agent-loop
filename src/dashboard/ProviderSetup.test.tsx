import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderSetupPanel } from "./ProviderSetup.js";
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
      manualEntry={false}
      draftProvider="codex-local"
      modelLabel="gpt-5-codex-subscription"
      codexCommandPath="C:\\Tools\\codex.cmd"
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onManualEntryChange={() => undefined}
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
      manualEntry={false}
      draftProvider="mock"
      modelLabel="mock-v1"
      codexCommandPath=""
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onManualEntryChange={() => undefined}
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

test("provider setup panel keeps manual and Codex default fallback when catalog is unavailable", () => {
  const html = renderCatalogPanel(null, { modelLabel: "" });

  assert.match(html, /Model catalog unavailable/);
  // A manual text input (with the Codex default placeholder) remains available.
  assert.match(html, /placeholder="Codex CLI default"/);
});

test("provider setup panel shows empty-state fallback when no models are returned", () => {
  const html = renderCatalogPanel({
    models: [],
    defaultModelSlug: null,
    source: "path",
    status: { state: "empty", checkedAt: null, message: null },
  });

  assert.match(html, /No selectable models were found/);
  assert.match(html, /placeholder="Codex CLI default"/);
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
  overrides?: { modelLabel?: string; manualEntry?: boolean },
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
      manualEntry={overrides?.manualEntry ?? false}
      draftProvider="codex-local"
      modelLabel={overrides?.modelLabel ?? ""}
      codexCommandPath="C:\\Tools\\codex.cmd"
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onManualEntryChange={() => undefined}
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
      manualEntry={false}
      draftProvider={settings.provider}
      modelLabel={settings.modelLabel}
      codexCommandPath={settings.codexCommandPath ?? ""}
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onManualEntryChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
      onReloadCatalog={() => undefined}
    />,
  );
}
