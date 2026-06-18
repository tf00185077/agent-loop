import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createProviderSettingsRepository } from "./provider-settings-repository.js";

test("returns mock defaults when no provider settings row exists", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const settings = createProviderSettingsRepository(db);

  assert.deepEqual(settings.get(), {
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

  db.close();
});

test("saves one local provider settings record", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const settings = createProviderSettingsRepository(db);

  const saved = settings.save({
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Users\\TIM\\codex.exe",
    status: {
      state: "detected",
      detected: true,
      checkedAt: "2026-06-18T00:00:00.000Z",
      message: "Codex CLI detected",
    },
  });

  assert.deepEqual(saved, settings.get());
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM provider_settings").get() as { count: number }).count,
    1,
  );

  db.close();
});

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "auto-agent-provider-settings-")), "settings.sqlite");
}
