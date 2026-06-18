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

test("initializes lifecycle and provider settings tables", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "schema.sqlite");
  const db = openDatabase({ path: dbPath });

  assert.deepEqual(tableNames(db), ["events", "goals", "provider_settings", "runs", "steps"]);
  assert.deepEqual(columnNames(db, "goals"), [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "agent_type",
    "created_at",
    "updated_at",
    "started_at",
    "completed_at",
  ]);
  assert.deepEqual(columnNames(db, "runs"), [
    "id",
    "goal_id",
    "status",
    "provider",
    "model",
    "started_at",
    "finished_at",
    "error",
  ]);
  assert.deepEqual(columnNames(db, "steps"), [
    "id",
    "goal_id",
    "run_id",
    "title",
    "description",
    "status",
    "step_order",
    "result",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "events"), [
    "id",
    "goal_id",
    "run_id",
    "step_id",
    "type",
    "message",
    "data",
    "created_at",
  ]);
  assert.deepEqual(columnNames(db, "provider_settings"), [
    "id",
    "provider",
    "model_label",
    "codex_command_path",
    "status_state",
    "status_detected",
    "status_checked_at",
    "status_message",
    "updated_at",
  ]);
  assert.deepEqual(foreignKeys(db, "runs"), [{ from: "goal_id", table: "goals", to: "id" }]);
  assert.deepEqual(foreignKeys(db, "steps"), [
    { from: "run_id", table: "runs", to: "id" },
    { from: "goal_id", table: "goals", to: "id" },
  ]);
  assert.deepEqual(foreignKeys(db, "events"), [
    { from: "step_id", table: "steps", to: "id" },
    { from: "run_id", table: "runs", to: "id" },
    { from: "goal_id", table: "goals", to: "id" },
  ]);

  db.close();
});

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function foreignKeys(db: ReturnType<typeof openDatabase>, table: string): Array<{ from: string; table: string; to: string }> {
  return db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((row) => {
      const value = row as { from: string; table: string; to: string };
      return { from: value.from, table: value.table, to: value.to };
    });
}
