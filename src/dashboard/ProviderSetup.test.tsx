import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderSetupPanel } from "./ProviderSetup.js";

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
      draftProvider="codex-local"
      modelLabel="gpt-5-codex-subscription"
      codexCommandPath="C:\\Tools\\codex.cmd"
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
    />,
  );

  assert.match(html, /Provider setup/);
  assert.match(html, /Codex Local/);
  assert.match(html, /Model label/);
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
      draftProvider="mock"
      modelLabel="mock-v1"
      codexCommandPath=""
      onProviderChange={() => undefined}
      onModelLabelChange={() => undefined}
      onCodexCommandPathChange={() => undefined}
      onSave={() => undefined}
      onDetect={() => undefined}
      onTestConnection={() => undefined}
    />,
  );

  assert.match(html, /Mock/);
  assert.doesNotMatch(html, /Command path/);
  assert.doesNotMatch(html, /Test connection/);
});
