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
    "managed_task_criteria",
    "managed_task_criterion_results",
    "managed_task_deliveries",
    "managed_task_reviews",
    "managed_tasks",
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
  assert.deepEqual(columnNames(db, "managed_tasks"), [
    "id", "goal_id", "change_id", "parent_task_id", "title", "status", "attempt_count",
    "substantive_rejection_count", "last_cited_criteria", "last_safe_summary", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_criteria"), [
    "task_id", "criterion_id", "text", "outcome", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_criterion_results"), [
    "id", "task_id", "worker_delegation_request_id", "criterion_id", "executor_evidence",
    "judge_outcome", "judge_safe_summary", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_reviews"), [
    "id", "task_id", "worker_delegation_request_id", "judge_delegation_request_id", "status",
    "verdict", "decisions", "cited_criteria", "safe_summary", "deferred_findings", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_deliveries"), [
    "id", "task_id", "worker_delegation_request_id", "status", "checkpoint_head", "checkpoint_status",
    "candidate_commit_sha", "commit_sha", "validation_command", "validation_exit_code", "validation_summary",
    "rollback_summary", "safe_summary", "created_at", "updated_at",
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
    "role_assignments",
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
    "task_id",
    "change_id",
    "acceptance",
    "result_summary",
    "detached_reason",
    "created_at",
    "updated_at",
    "accepted_at",
    "started_at",
    "completed_at",
    "attempt_number",
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
  assert.deepEqual(foreignKeys(db, "managed_tasks"), [
    { from: "parent_task_id", table: "managed_tasks", to: "id" },
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

test("migrates a pre-managed-task database without rewriting terminal goals", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "legacy-managed.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL, agent_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT
    );
    CREATE TABLE agent_delegation_requests (
      id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, child_session_id TEXT, role TEXT NOT NULL,
      status TEXT NOT NULL, prompt_summary TEXT NOT NULL, result_summary TEXT, detached_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT, started_at TEXT, completed_at TEXT
    );
    INSERT INTO goals VALUES (
      'done-goal', 'Done', 'Historical', 'completed', 'medium', 'managed',
      '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
      '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'
    );
  `);
  legacy.close();

  const db = openDatabase({ path: dbPath });
  assert.ok(columnNames(db, "agent_delegation_requests").includes("attempt_number"));
  assert.equal((db.prepare("SELECT status FROM goals WHERE id = ?").get("done-goal") as { status: string }).status, "completed");
  assert.ok(tableNames(db).includes("managed_tasks"));
  db.close();
});

test("backfills non-terminal historical task contracts fail-closed", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "backfill.sqlite");
  let db = openDatabase({ path: dbPath });
  db.exec(`
    INSERT INTO goals VALUES ('live', 'Live', 'Historical', 'running', 'normal', 'managed', 't0', 't0', 't0', NULL);
    INSERT INTO runs VALUES ('run-live', 'live', 'running', 'mock', 'mock', 't0', NULL, NULL);
    INSERT INTO agent_sessions VALUES (
      'session-live', 'live', 'run-live', 'mock', 'mock', 'completed',
      '{"eventStreaming":true,"approval":false,"cancellation":true,"resume":false,"childSessions":true}',
      NULL, 't0', 't1', NULL
    );
    INSERT INTO events VALUES (
      'event-list', 'live', 'run-live', NULL, 'agent.progress', 'Tasks',
      '{"runtimeEventType":"supervisor.task_list","taskList":[{"id":"legacy-task","title":"Legacy","acceptance":[{"id":"A1","text":"Verified"}]}]}',
      't0'
    );
    INSERT INTO agent_delegation_requests (
      id, parent_session_id, child_session_id, role, status, prompt_summary, task_id, result_summary,
      detached_reason, created_at, updated_at, accepted_at, started_at, completed_at
    ) VALUES (
      'legacy-attempt', 'session-live', NULL, 'worker', 'completed', 'Legacy', 'legacy-task',
      '{"kind":"success","safeSummary":"Worker claimed success."}', NULL, 't0', 't1', 't0', 't0', 't1'
    );
    DROP TABLE managed_task_deliveries;
    DROP TABLE managed_task_reviews;
    DROP TABLE managed_task_criterion_results;
    DROP TABLE managed_task_criteria;
    DROP TABLE managed_tasks;
  `);
  db.close();

  db = openDatabase({ path: dbPath });
  const task = db.prepare("SELECT status, attempt_count, last_safe_summary FROM managed_tasks WHERE id = 'legacy-task'")
    .get() as { status: string; attempt_count: number; last_safe_summary: string };
  assert.deepEqual(task, { status: "awaiting_review", attempt_count: 1, last_safe_summary: "Worker claimed success." });
  assert.equal((db.prepare("SELECT outcome FROM managed_task_criteria WHERE task_id = 'legacy-task'").get() as { outcome: string }).outcome, "UNKNOWN");
  assert.equal((db.prepare("SELECT attempt_number FROM agent_delegation_requests WHERE id = 'legacy-attempt'").get() as { attempt_number: number }).attempt_number, 1);
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
