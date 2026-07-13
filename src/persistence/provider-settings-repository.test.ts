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

test("round-trips sanitized role assignments across database reopen", () => {
  const dbPath = testDatabasePath();
  const firstDb = openDatabase({ path: dbPath });

  const saved = createProviderSettingsRepository(firstDb).save({
    provider: "codex-local",
    modelLabel: "gpt-5.5",
    codexCommandPath: "C:\\Tools\\codex.exe",
    status: { state: "detected", detected: true, checkedAt: null, message: null },
    roleAssignments: {
      worker: {
        provider: "claude-local",
        modelLabel: "claude-sonnet-4",
        commandPath: "C:\\Tools\\claude.cmd --api-key sk-secret",
      },
      review_merge: { provider: "codex-local", modelLabel: "", commandPath: null },
    },
  });
  firstDb.close();

  assert.equal(saved.roleAssignments?.worker?.commandPath, "C:\\Tools\\claude.cmd");
  const reopened = openDatabase({ path: dbPath });
  const settings = createProviderSettingsRepository(reopened).get();
  assert.deepEqual(settings.roleAssignments, {
    worker: {
      provider: "claude-local",
      modelLabel: "claude-sonnet-4",
      commandPath: "C:\\Tools\\claude.cmd",
    },
    review_merge: { provider: "codex-local", modelLabel: "", commandPath: null },
  });
  reopened.close();
});

test("settings without role assignments read back without the field", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const settings = createProviderSettingsRepository(db);

  settings.save({
    provider: "codex-local",
    modelLabel: "gpt-5.5",
    codexCommandPath: "C:\\Tools\\codex.exe",
    status: { state: "detected", detected: true, checkedAt: null, message: null },
  });

  assert.equal("roleAssignments" in settings.get(), false);
  db.close();
});

test("saved Codex Local provider settings survive database reopen", () => {
  const dbPath = testDatabasePath();
  const firstDb = openDatabase({ path: dbPath });

  createProviderSettingsRepository(firstDb).save({
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
    status: {
      state: "connected",
      detected: true,
      checkedAt: "2026-06-18T01:00:00.000Z",
      message: "Codex Local ready",
    },
  });
  firstDb.close();

  const reopenedDb = openDatabase({ path: dbPath });
  const settings = createProviderSettingsRepository(reopenedDb);

  assert.deepEqual(settings.get(), {
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
    status: {
      state: "connected",
      detected: true,
      checkedAt: "2026-06-18T01:00:00.000Z",
      message: "Codex Local ready",
    },
  });

  reopenedDb.close();
});

test("saves and round-trips Claude Local provider settings", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const settings = createProviderSettingsRepository(db);

  const saved = settings.save({
    provider: "claude-local",
    modelLabel: "claude-sonnet-4-6",
    claudeCommandPath: "/home/u/.local/bin/claude",
    status: {
      state: "detected",
      detected: true,
      checkedAt: "2026-06-21T00:00:00.000Z",
      message: "Claude CLI detected",
    },
  });

  assert.deepEqual(saved, settings.get());
  assert.equal(saved.provider, "claude-local");
  assert.equal(
    (saved as { claudeCommandPath: string | null }).claudeCommandPath,
    "/home/u/.local/bin/claude",
  );

  db.close();
});

test("saved Claude Local provider settings survive database reopen", () => {
  const dbPath = testDatabasePath();
  const firstDb = openDatabase({ path: dbPath });

  createProviderSettingsRepository(firstDb).save({
    provider: "claude-local",
    modelLabel: "",
    claudeCommandPath: "/home/u/.local/bin/claude",
    status: {
      state: "detected",
      detected: true,
      checkedAt: "2026-06-21T01:00:00.000Z",
      message: "Claude CLI detected",
    },
  });
  firstDb.close();

  const reopenedDb = openDatabase({ path: dbPath });
  const settings = createProviderSettingsRepository(reopenedDb);

  assert.deepEqual(settings.get(), {
    provider: "claude-local",
    modelLabel: "",
    claudeCommandPath: "/home/u/.local/bin/claude",
    status: {
      state: "detected",
      detected: true,
      checkedAt: "2026-06-21T01:00:00.000Z",
      message: "Claude CLI detected",
    },
  });

  reopenedDb.close();
});

test("persisted provider settings exclude credential material and command secret arguments", () => {
  const db = openDatabase({ path: testDatabasePath() });
  const settings = createProviderSettingsRepository(db);

  settings.save({
    provider: "codex-local",
    modelLabel: "gpt-5-codex-subscription",
    codexCommandPath: "C:\\Users\\TIM\\codex.exe --api-key cmd-secret --token cmd-token",
    status: {
      state: "command_failure",
      detected: true,
      checkedAt: "2026-06-18T02:00:00.000Z",
      message:
        'failed with sk-api-secret Authorization: Bearer bearer-secret {"access_token":"auth-cache-secret"} cookie=session-secret; --api-key arg-secret',
    },
  });

  const row = db.prepare("SELECT * FROM provider_settings WHERE id = 'local'").get();
  const persisted = JSON.stringify(row);

  for (const secret of [
    "sk-api-secret",
    "bearer-secret",
    "auth-cache-secret",
    "session-secret",
    "arg-secret",
    "cmd-secret",
    "cmd-token",
  ]) {
    assert.equal(persisted.includes(secret), false, `persisted row leaked ${secret}`);
  }

  db.close();
});

function testDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "auto-agent-provider-settings-")), "settings.sqlite");
}
