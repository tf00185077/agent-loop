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
      role_assignments TEXT,
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
      task_id TEXT,
      change_id TEXT,
      acceptance TEXT,
      result_summary TEXT,
      detached_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accepted_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      attempt_number INTEGER
    );

    CREATE TABLE IF NOT EXISTS managed_tasks (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      change_id TEXT,
      parent_task_id TEXT REFERENCES managed_tasks(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'registered', 'delegated', 'awaiting_review', 'rejected', 'split',
        'failed', 'blocked', 'awaiting_delivery', 'accepted'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      substantive_rejection_count INTEGER NOT NULL DEFAULT 0 CHECK (substantive_rejection_count >= 0),
      last_cited_criteria TEXT NOT NULL DEFAULT '[]',
      last_safe_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (goal_id, id)
    );

    CREATE TABLE IF NOT EXISTS managed_task_criteria (
      task_id TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
      criterion_id TEXT NOT NULL,
      text TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (outcome IN ('UNKNOWN', 'PASS', 'FAIL', 'BLOCKED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, criterion_id)
    );

    CREATE TABLE IF NOT EXISTS managed_task_criterion_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      criterion_id TEXT NOT NULL,
      executor_evidence TEXT,
      judge_outcome TEXT CHECK (judge_outcome IN ('PASS', 'FAIL', 'BLOCKED')),
      judge_safe_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id, criterion_id) REFERENCES managed_task_criteria(task_id, criterion_id),
      UNIQUE (worker_delegation_request_id, criterion_id)
    );

    CREATE TABLE IF NOT EXISTS managed_task_integrations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      integrator_delegation_request_id TEXT REFERENCES agent_delegation_requests(id),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'resolving', 'awaiting_review', 'accepted', 'rejected', 'blocked',
        'resolution_failed', 'interrupted', 'committed'
      )),
      checkpoint_head TEXT NOT NULL,
      original_candidate_commit_sha TEXT NOT NULL,
      resolved_candidate_commit_sha TEXT,
      conflict_files TEXT NOT NULL DEFAULT '[]',
      allowed_files TEXT NOT NULL DEFAULT '[]',
      safe_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (worker_delegation_request_id, original_candidate_commit_sha)
    );

    CREATE TABLE IF NOT EXISTS managed_task_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      judge_delegation_request_id TEXT REFERENCES agent_delegation_requests(id),
      integration_attempt_id TEXT REFERENCES managed_task_integrations(id),
      reviewed_candidate_commit_sha TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked', 'malformed')),
      verdict TEXT CHECK (verdict IN ('accepted', 'rejected', 'blocked')),
      decisions TEXT NOT NULL DEFAULT '[]',
      cited_criteria TEXT NOT NULL DEFAULT '[]',
      safe_summary TEXT NOT NULL,
      deferred_findings TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (judge_delegation_request_id)
    );

    CREATE TABLE IF NOT EXISTS managed_task_deliveries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      integration_attempt_id TEXT REFERENCES managed_task_integrations(id),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'committed', 'rejected', 'conflict', 'integration_failed', 'test_failed_reverted',
        'revert_failed', 'failed', 'verification_failed'
      )),
      checkpoint_head TEXT,
      checkpoint_status TEXT,
      candidate_commit_sha TEXT,
      commit_sha TEXT,
      validation_command TEXT,
      validation_exit_code INTEGER,
      validation_summary TEXT,
      rollback_summary TEXT,
      safe_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (worker_delegation_request_id)
    );
  `);

  // Additive migration for databases created before claude-local support: the
  // CREATE TABLE IF NOT EXISTS above does not alter an existing table.
  ensureColumn(db, "provider_settings", "claude_command_path", "TEXT");
  ensureColumn(db, "agent_sessions", "worktree", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "task_id", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "acceptance", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "change_id", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "attempt_number", "INTEGER");
  ensureColumn(db, "provider_settings", "role_assignments", "TEXT");
  ensureColumn(db, "managed_task_reviews", "integration_attempt_id", "TEXT");
  ensureColumn(db, "managed_task_reviews", "reviewed_candidate_commit_sha", "TEXT");
  ensureColumn(db, "managed_task_deliveries", "integration_attempt_id", "TEXT");
  migrateManagedTaskDeliveriesOutcome(db);
  backfillManagedTaskState(db);
}

function migrateManagedTaskDeliveriesOutcome(db: AppDatabase): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'managed_task_deliveries'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("integration_failed")) return;
  db.exec(`
    ALTER TABLE managed_task_deliveries RENAME TO managed_task_deliveries_legacy;
    CREATE TABLE managed_task_deliveries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES managed_tasks(id),
      worker_delegation_request_id TEXT NOT NULL REFERENCES agent_delegation_requests(id),
      integration_attempt_id TEXT REFERENCES managed_task_integrations(id),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'committed', 'rejected', 'conflict', 'integration_failed', 'test_failed_reverted',
        'revert_failed', 'failed', 'verification_failed'
      )),
      checkpoint_head TEXT,
      checkpoint_status TEXT,
      candidate_commit_sha TEXT,
      commit_sha TEXT,
      validation_command TEXT,
      validation_exit_code INTEGER,
      validation_summary TEXT,
      rollback_summary TEXT,
      safe_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (worker_delegation_request_id)
    );
    INSERT INTO managed_task_deliveries (
      id, task_id, worker_delegation_request_id, integration_attempt_id, status, checkpoint_head,
      checkpoint_status, candidate_commit_sha, commit_sha, validation_command, validation_exit_code,
      validation_summary, rollback_summary, safe_summary, created_at, updated_at
    ) SELECT id, task_id, worker_delegation_request_id, integration_attempt_id, status, checkpoint_head,
      checkpoint_status, candidate_commit_sha, commit_sha, validation_command, validation_exit_code,
      validation_summary, rollback_summary, safe_summary, created_at, updated_at
    FROM managed_task_deliveries_legacy;
    DROP TABLE managed_task_deliveries_legacy;
  `);
}

function ensureColumn(db: AppDatabase, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function backfillManagedTaskState(db: AppDatabase): void {
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT e.goal_id, e.run_id, e.data, e.created_at
      FROM events e JOIN goals g ON g.id = e.goal_id
      WHERE g.status NOT IN ('completed', 'failed')
      ORDER BY e.created_at, e.rowid
    `).all() as Array<{ goal_id: string; run_id: string | null; data: string; created_at: string }>;
    for (const row of rows) {
      const data = parseRecord(row.data);
      if (data?.runtimeEventType !== "supervisor.task_list" || !Array.isArray(data.taskList)) continue;
      for (const rawTask of data.taskList) {
        const task = asRecord(rawTask);
        if (!task || typeof task.id !== "string" || typeof task.title !== "string") continue;
        db.prepare(`
          INSERT OR IGNORE INTO managed_tasks (
            id, goal_id, change_id, parent_task_id, title, status, attempt_count,
            substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, 'registered', 0, 0, '[]', NULL, ?, ?)
        `).run(
          task.id, row.goal_id, typeof data.changeId === "string" ? data.changeId : null,
          task.title, row.created_at, row.created_at,
        );
        if (Array.isArray(task.acceptance)) {
          for (const rawCriterion of task.acceptance) {
            const criterion = asRecord(rawCriterion);
            if (!criterion || typeof criterion.id !== "string" || typeof criterion.text !== "string") continue;
            db.prepare(`
              INSERT OR IGNORE INTO managed_task_criteria
                (task_id, criterion_id, text, outcome, created_at, updated_at)
              VALUES (?, ?, ?, 'UNKNOWN', ?, ?)
            `).run(task.id, criterion.id, criterion.text, row.created_at, row.created_at);
          }
        }
      }
      for (const rawTask of data.taskList) {
        const task = asRecord(rawTask);
        if (!task || typeof task.id !== "string" || typeof task.parentTaskId !== "string") continue;
        db.prepare(`
          UPDATE managed_tasks SET parent_task_id = ?
          WHERE id = ? AND goal_id = ? AND EXISTS (SELECT 1 FROM managed_tasks WHERE id = ? AND goal_id = ?)
        `).run(task.parentTaskId, task.id, row.goal_id, task.parentTaskId, row.goal_id);
      }
    }

    const taskRows = db.prepare(`
      SELECT id, goal_id FROM managed_tasks
      WHERE goal_id IN (SELECT id FROM goals WHERE status NOT IN ('completed', 'failed'))
    `).all() as Array<{ id: string; goal_id: string }>;
    for (const task of taskRows) {
      const attempts = db.prepare(`
        SELECT d.id, d.status, d.result_summary, d.updated_at, d.attempt_number
        FROM agent_delegation_requests d
        JOIN agent_sessions s ON s.id = d.parent_session_id
        WHERE s.goal_id = ? AND d.task_id = ? AND d.role = 'worker'
        ORDER BY d.created_at, d.rowid
      `).all(task.goal_id, task.id) as Array<{
        id: string;
        status: string;
        result_summary: string | null;
        updated_at: string;
        attempt_number: number | null;
      }>;
      attempts.forEach((attempt, index) => {
        if (attempt.attempt_number === null) {
          db.prepare("UPDATE agent_delegation_requests SET attempt_number = ? WHERE id = ?").run(index + 1, attempt.id);
        }
      });
      if (attempts.length === 0) continue;
      const latest = attempts.at(-1)!;
      const summary = latest.result_summary ? parseRecord(latest.result_summary) : null;
      const safeSummary = typeof summary?.safeSummary === "string" ? summary.safeSummary.slice(0, 500) : null;
      const status = ["requested", "accepted", "running"].includes(latest.status)
        ? "delegated"
        : latest.status === "completed" ? "awaiting_review" : "failed";
      db.prepare(`
        UPDATE managed_tasks SET status = ?, attempt_count = ?, last_safe_summary = ?, updated_at = ?
        WHERE id = ? AND status = 'registered' AND attempt_count = 0
      `).run(status, attempts.length, safeSummary, latest.updated_at, task.id);
    }
  })();
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
