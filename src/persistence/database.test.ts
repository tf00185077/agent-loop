import assert from "node:assert/strict";
import Database from "better-sqlite3";
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

  assert.deepEqual(tableNames(db), [
    "agent_child_session_requests",
    "agent_delegation_requests",
    "agent_runtime_approvals",
    "agent_runtime_commands",
    "agent_sessions",
    "events",
    "goals",
    "provider_settings",
    "runs",
    "steps",
  ]);
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
    "claude_command_path",
    "status_state",
    "status_detected",
    "status_checked_at",
    "status_message",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "agent_sessions"), [
    "id",
    "goal_id",
    "run_id",
    "provider_id",
    "model_label",
    "lifecycle_state",
    "capabilities",
    "parent",
    "created_at",
    "last_activity_at",
    "worktree",
  ]);
  assert.deepEqual(columnNames(db, "agent_runtime_commands"), [
    "id",
    "session_id",
    "status",
    "safe_command",
    "cwd",
    "started_at",
    "completed_at",
    "exit_code",
    "diagnostics",
  ]);
  assert.deepEqual(columnNames(db, "agent_runtime_approvals"), [
    "id",
    "session_id",
    "command_id",
    "status",
    "safe_summary",
    "created_at",
    "resolved_at",
    "resolution_reason",
  ]);
  assert.deepEqual(columnNames(db, "agent_child_session_requests"), [
    "id",
    "parent_session_id",
    "parent_agent_id",
    "child_role",
    "task_id",
    "prompt_summary",
    "status",
    "created_at",
    "resolved_at",
    "safe_reason",
  ]);
  assert.deepEqual(columnNames(db, "agent_delegation_requests"), [
    "id",
    "parent_session_id",
    "child_session_id",
    "role",
    "status",
    "prompt_summary",
    "result_summary",
    "detached_reason",
    "created_at",
    "updated_at",
    "accepted_at",
    "started_at",
    "completed_at",
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
  assert.deepEqual(foreignKeys(db, "agent_sessions"), [
    { from: "run_id", table: "runs", to: "id" },
    { from: "goal_id", table: "goals", to: "id" },
  ]);
  assert.deepEqual(foreignKeys(db, "agent_runtime_commands"), [
    { from: "session_id", table: "agent_sessions", to: "id" },
  ]);
  assert.deepEqual(foreignKeys(db, "agent_runtime_approvals"), [
    { from: "command_id", table: "agent_runtime_commands", to: "id" },
    { from: "session_id", table: "agent_sessions", to: "id" },
  ]);
  assert.deepEqual(foreignKeys(db, "agent_child_session_requests"), [
    { from: "parent_session_id", table: "agent_sessions", to: "id" },
  ]);
  assert.deepEqual(foreignKeys(db, "agent_delegation_requests"), [
    { from: "child_session_id", table: "agent_sessions", to: "id" },
    { from: "parent_session_id", table: "agent_sessions", to: "id" },
  ]);

  db.close();
});

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

test("adds claude_command_path to a provider_settings table that predates it", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "legacy.sqlite");

  // Simulate a database created before claude-local support.
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE provider_settings (
      id TEXT PRIMARY KEY CHECK (id = 'local'),
      provider TEXT NOT NULL,
      model_label TEXT NOT NULL,
      codex_command_path TEXT,
      status_state TEXT NOT NULL,
      status_detected INTEGER NOT NULL,
      status_checked_at TEXT,
      status_message TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const db = openDatabase({ path: dbPath });
  assert.ok(columnNames(db, "provider_settings").includes("claude_command_path"));
  db.close();
});

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
