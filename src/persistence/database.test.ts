import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { defaultDatabasePath, openDatabase, resolveDatabasePath } from "./database.js";

test("resolves a local default SQLite database path", () => {
  assert.equal(defaultDatabasePath, resolve("data", "auto-agent.sqlite"));
  assert.equal(resolveDatabasePath(), defaultDatabasePath);
});

test("opens SQLite at a configured path", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "custom.sqlite");
  const db = openDatabase({ path: dbPath });

  assert.equal(resolveDatabasePath({ path: dbPath }), dbPath);
  assert.equal(db.name, dbPath);

  db.close();
});
