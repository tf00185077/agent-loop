import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DatabaseOptions {
  path?: string;
}

export type AppDatabase = Database.Database;

export const defaultDatabasePath = resolve("data", "auto-agent.sqlite");

export function resolveDatabasePath(options: DatabaseOptions = {}): string {
  return options.path ?? process.env.AUTO_AGENT_DB_PATH ?? defaultDatabasePath;
}

export function openDatabase(options: DatabaseOptions = {}): AppDatabase {
  const path = resolveDatabasePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  initializeSchema(db);
  return db;
}

function initializeSchema(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      run_id TEXT REFERENCES runs(id),
      step_id TEXT REFERENCES steps(id),
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_settings (
      id TEXT PRIMARY KEY CHECK (id = 'local'),
      provider TEXT NOT NULL,
      model_label TEXT NOT NULL,
      codex_command_path TEXT,
      claude_command_path TEXT,
      status_state TEXT NOT NULL,
      status_detected INTEGER NOT NULL,
      status_checked_at TEXT,
      status_message TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      provider_id TEXT NOT NULL,
      model_label TEXT,
      lifecycle_state TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      parent TEXT,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runtime_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      status TEXT NOT NULL,
      safe_command TEXT NOT NULL,
      cwd TEXT,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      diagnostics TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runtime_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      command_id TEXT REFERENCES agent_runtime_commands(id),
      status TEXT NOT NULL,
      safe_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_child_session_requests (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      parent_agent_id TEXT,
      child_role TEXT NOT NULL,
      task_id TEXT,
      prompt_summary TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      safe_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_delegation_requests (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      child_session_id TEXT REFERENCES agent_sessions(id),
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_summary TEXT NOT NULL,
      result_summary TEXT,
      detached_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accepted_at TEXT,
      started_at TEXT,
      completed_at TEXT
    );
  `);

  // Additive migration for databases created before claude-local support: the
  // CREATE TABLE IF NOT EXISTS above does not alter an existing table.
  ensureColumn(db, "provider_settings", "claude_command_path", "TEXT");
  ensureColumn(db, "agent_sessions", "worktree", "TEXT");
}

function ensureColumn(db: AppDatabase, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
