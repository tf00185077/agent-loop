import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DatabaseOptions {
  path?: string;
  /** Test-only deterministic fault hook for named migration transaction windows. */
  migrationFault?: (migrationName: string, point: MigrationFaultPoint) => void;
}

export type MigrationFaultPoint = "before_row_update" | "before_marker_insert" | "after_commit";

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
  const preInitialization = inspectPreInitializationSchema(db);
  try {
    initializeSchema(db, preInitialization, options.migrationFault);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

interface PreInitializationSchema {
  applicationSchemaExisted: boolean;
  managedTaskLedgerExisted: boolean;
}

const LEGACY_MANAGED_TASK_BACKFILL = "managed-task-legacy-backfill-v1";
const FROZEN_CONTRACT_REPAIR = "managed-task-frozen-contract-repair-v1";
const SPLIT_LINEAGE_REPAIR = "managed-task-split-lineage-repair-v1";

function inspectPreInitializationSchema(db: AppDatabase): PreInitializationSchema {
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;
  const names = new Set(tables.map((table) => table.name));
  return {
    applicationSchemaExisted: names.size > 0,
    managedTaskLedgerExisted: names.has("managed_tasks"),
  };
}

function initializeSchema(
  db: AppDatabase,
  preInitialization: PreInitializationSchema,
  migrationFault?: DatabaseOptions["migrationFault"],
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      confirmation_policy TEXT,
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
      logical_task_id TEXT NOT NULL,
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
      UNIQUE (goal_id, logical_task_id)
    );

    CREATE TABLE IF NOT EXISTS managed_task_criteria (
      task_id TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
      criterion_id TEXT NOT NULL,
      text TEXT NOT NULL,
      check_json TEXT,
      outcome TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (outcome IN ('UNKNOWN', 'PASS', 'FAIL', 'BLOCKED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, criterion_id)
    );

    CREATE TABLE IF NOT EXISTS managed_task_check_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES managed_tasks(id) ON DELETE CASCADE,
      worker_delegation_request_id TEXT NOT NULL,
      criterion_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('candidate', 'baseline')),
      kind TEXT NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      output_summary TEXT NOT NULL,
      failed_to_run INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS managed_goal_recovery_authorizations (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      plan_digest TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      database_before_sha TEXT NOT NULL,
      backup_sha TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      archive_commit_sha TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (goal_id, plan_digest)
    );

    CREATE TABLE IF NOT EXISTS managed_change_archive_operations (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      change_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      pre_archive_head TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'blocked')),
      archive_commit_sha TEXT,
      diagnostics TEXT NOT NULL DEFAULT '[]',
      operator_authorization_id TEXT REFERENCES managed_goal_recovery_authorizations(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalized_at TEXT,
      UNIQUE (goal_id, change_id)
    );

    CREATE TABLE IF NOT EXISTS goal_input_requests (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id),
      reason_code TEXT NOT NULL,
      safe_summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      response TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS goal_input_requests_single_pending
      ON goal_input_requests (goal_id) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      details TEXT NOT NULL
    );
  `);

  migrateManagedTaskIdentities(db);
  enforceManagedTaskLogicalIdentity(db);

  // Additive migration for databases created before claude-local support: the
  // CREATE TABLE IF NOT EXISTS above does not alter an existing table.
  ensureColumn(db, "provider_settings", "claude_command_path", "TEXT");
  ensureColumn(db, "agent_sessions", "worktree", "TEXT");
  ensureColumn(db, "agent_sessions", "provider_session_id", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "task_id", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "acceptance", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "change_id", "TEXT");
  ensureColumn(db, "agent_delegation_requests", "attempt_number", "INTEGER");
  ensureColumn(db, "provider_settings", "role_assignments", "TEXT");
  // Caller-owned confirmation policy; default off keeps existing goals autonomous.
  ensureColumn(db, "goals", "confirmation_policy", "TEXT");
  ensureColumn(db, "managed_task_reviews", "integration_attempt_id", "TEXT");
  ensureColumn(db, "managed_task_criteria", "check_json", "TEXT");
  ensureColumn(db, "managed_task_reviews", "reviewed_candidate_commit_sha", "TEXT");
  ensureColumn(db, "managed_task_deliveries", "integration_attempt_id", "TEXT");
  migrateManagedTaskDeliveriesOutcome(db);
  runManagedTaskMigrations(db, preInitialization, migrationFault);
}

function runManagedTaskMigrations(
  db: AppDatabase,
  preInitialization: PreInitializationSchema,
  migrationFault?: DatabaseOptions["migrationFault"],
): void {
  applyNamedMigration(db, LEGACY_MANAGED_TASK_BACKFILL, () => {
    if (!preInitialization.applicationSchemaExisted) {
      return { mode: "fresh_baseline" };
    }
    if (preInitialization.managedTaskLedgerExisted) {
      return { mode: "initialized_ledger_baseline" };
    }
    backfillManagedTaskState(db);
    return { mode: "legacy_backfill" };
  });

  applyNamedMigration(db, FROZEN_CONTRACT_REPAIR, () => {
    if (!preInitialization.applicationSchemaExisted) {
      return { mode: "fresh_baseline" };
    }
    return repairFrozenManagedTaskContracts(db);
  });

  applyNamedMigration(db, SPLIT_LINEAGE_REPAIR, () => {
    if (!preInitialization.applicationSchemaExisted) {
      return { mode: "fresh_baseline" };
    }
    return repairManagedTaskSplitLineage(
      db,
      () => migrationFault?.(SPLIT_LINEAGE_REPAIR, "before_row_update"),
    );
  }, migrationFault);
}

function applyNamedMigration(
  db: AppDatabase,
  name: string,
  migrate: () => Record<string, unknown>,
  migrationFault?: DatabaseOptions["migrationFault"],
): void {
  const alreadyApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name);
  if (alreadyApplied) return;
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) return;
    const details = JSON.stringify(migrate());
    migrationFault?.(name, "before_marker_insert");
    db.prepare("INSERT INTO schema_migrations (name, applied_at, details) VALUES (?, ?, ?)")
      .run(name, new Date().toISOString(), details);
  })();
  migrationFault?.(name, "after_commit");
}

function migrateManagedTaskIdentities(db: AppDatabase): void {
  const columns = db.prepare("PRAGMA table_info(managed_tasks)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "logical_task_id")) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE managed_tasks ADD COLUMN logical_task_id TEXT;
        UPDATE managed_tasks SET logical_task_id = id;
        CREATE TEMP TABLE managed_task_identity_map (
          legacy_id TEXT PRIMARY KEY,
          internal_id TEXT NOT NULL UNIQUE
        );
      `);
      const insertIdentity = db.prepare(
        "INSERT INTO managed_task_identity_map (legacy_id, internal_id) VALUES (?, ?)",
      );
      const legacyTasks = db.prepare("SELECT id FROM managed_tasks ORDER BY rowid").all() as Array<{ id: string }>;
      for (const task of legacyTasks) insertIdentity.run(task.id, randomUUID());
      db.exec(`
        UPDATE managed_tasks
        SET parent_task_id = (
          SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = managed_tasks.parent_task_id
        )
        WHERE parent_task_id IS NOT NULL;
        UPDATE managed_task_criteria
        SET task_id = (SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = task_id);
        UPDATE managed_task_criterion_results
        SET task_id = (SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = task_id);
        UPDATE managed_task_integrations
        SET task_id = (SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = task_id);
        UPDATE managed_task_reviews
        SET task_id = (SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = task_id);
        UPDATE managed_task_deliveries
        SET task_id = (SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = task_id);
        UPDATE managed_tasks
        SET id = (SELECT internal_id FROM managed_task_identity_map WHERE legacy_id = id);
        CREATE UNIQUE INDEX managed_tasks_goal_logical_id
          ON managed_tasks(goal_id, logical_task_id);
        DROP TABLE managed_task_identity_map;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`Managed task identity migration left ${violations.length} foreign-key violation(s).`);
  }
}

function enforceManagedTaskLogicalIdentity(db: AppDatabase): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS managed_tasks_logical_id_required_insert
    BEFORE INSERT ON managed_tasks
    WHEN NEW.logical_task_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'managed_tasks.logical_task_id is required');
    END;
    CREATE TRIGGER IF NOT EXISTS managed_tasks_logical_id_required_update
    BEFORE UPDATE OF logical_task_id ON managed_tasks
    WHEN NEW.logical_task_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'managed_tasks.logical_task_id is required');
    END;
  `);
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
      const ignoredTaskIds = new Set(
        Array.isArray(data.ignoredCriteriaMutations)
          ? data.ignoredCriteriaMutations.filter((value): value is string => typeof value === "string")
          : [],
      );
      for (const rawTask of data.taskList) {
        const task = asRecord(rawTask);
        if (!task || typeof task.id !== "string" || typeof task.title !== "string") continue;
        db.prepare(`
          INSERT OR IGNORE INTO managed_tasks (
            id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
            substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, 'registered', 0, 0, '[]', NULL, ?, ?)
        `).run(
          randomUUID(), row.goal_id, task.id, typeof data.changeId === "string" ? data.changeId : null,
          task.title, row.created_at, row.created_at,
        );
        if (!ignoredTaskIds.has(task.id) && Array.isArray(task.acceptance)) {
          for (const rawCriterion of task.acceptance) {
            const criterion = asRecord(rawCriterion);
            if (!criterion || typeof criterion.id !== "string" || typeof criterion.text !== "string") continue;
            db.prepare(`
              INSERT OR IGNORE INTO managed_task_criteria
                (task_id, criterion_id, text, outcome, created_at, updated_at)
              VALUES (?, ?, ?, 'UNKNOWN', ?, ?)
            `).run(
              db.prepare("SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = ?")
                .pluck().get(row.goal_id, task.id),
              criterion.id,
              criterion.text,
              row.created_at,
              row.created_at,
            );
          }
        }
      }
      for (const rawTask of data.taskList) {
        const task = asRecord(rawTask);
        if (!task || typeof task.id !== "string" || typeof task.parentTaskId !== "string") continue;
        db.prepare(`
          UPDATE managed_tasks
          SET parent_task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = ?)
          WHERE goal_id = ? AND logical_task_id = ?
            AND EXISTS (SELECT 1 FROM managed_tasks WHERE goal_id = ? AND logical_task_id = ?)
        `).run(row.goal_id, task.parentTaskId, row.goal_id, task.id, row.goal_id, task.parentTaskId);
      }
    }

    const taskRows = db.prepare(`
      SELECT id, goal_id, logical_task_id FROM managed_tasks
      WHERE goal_id IN (SELECT id FROM goals WHERE status NOT IN ('completed', 'failed'))
    `).all() as Array<{ id: string; goal_id: string; logical_task_id: string }>;
    for (const task of taskRows) {
      const attempts = db.prepare(`
        SELECT d.id, d.status, d.result_summary, d.updated_at, d.attempt_number
        FROM agent_delegation_requests d
        JOIN agent_sessions s ON s.id = d.parent_session_id
        WHERE s.goal_id = ? AND d.task_id = ? AND d.role = 'worker'
        ORDER BY d.created_at, d.rowid
      `).all(task.goal_id, task.logical_task_id) as Array<{
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

interface FrozenCriterionDefinition {
  id: string;
  text: string;
}

interface FrozenContractRepairDetails extends Record<string, unknown> {
  mode: "initialized_repair";
  repairedTaskCount: number;
  removedCriterionCount: number;
  removedCriterionResultCount: number;
  ambiguousTaskCount: number;
  ambiguousTasks: string[];
  ambiguousTaskEnforcementIds: string[];
}

function repairFrozenManagedTaskContracts(db: AppDatabase): FrozenContractRepairDetails {
  const syntheticContracts = new Map<string, FrozenCriterionDefinition[]>();
  const taskListContracts = new Map<string, FrozenCriterionDefinition[]>();
  const ignoredMutationCriteria = new Map<string, Set<string>>();
  const eventRows = db.prepare(`
    SELECT goal_id, data FROM events ORDER BY created_at, rowid
  `).all() as Array<{ goal_id: string; data: string }>;

  for (const event of eventRows) {
    const data = parseRecord(event.data);
    if (!data) continue;
    if (data.runtimeEventType === "supervisor.change_plan" && Array.isArray(data.specTasks)) {
      for (const rawSpecTask of data.specTasks) {
        const specTask = asRecord(rawSpecTask);
        if (!specTask || typeof specTask.taskId !== "string") continue;
        const acceptance = parseFrozenCriteria(specTask.acceptance);
        if (!acceptance) continue;
        const key = managedTaskContractKey(event.goal_id, specTask.taskId);
        if (!syntheticContracts.has(key)) syntheticContracts.set(key, acceptance);
      }
      continue;
    }
    if (data.runtimeEventType !== "supervisor.task_list" || !Array.isArray(data.taskList)) continue;
    const ignoredTaskIds = new Set(
      Array.isArray(data.ignoredCriteriaMutations)
        ? data.ignoredCriteriaMutations.filter((value): value is string => typeof value === "string")
        : [],
    );
    for (const rawTask of data.taskList) {
      const task = asRecord(rawTask);
      if (!task || typeof task.id !== "string") continue;
      const acceptance = parseFrozenCriteria(task.acceptance);
      if (!acceptance) continue;
      const key = managedTaskContractKey(event.goal_id, task.id);
      if (ignoredTaskIds.has(task.id)) {
        const ignored = ignoredMutationCriteria.get(key) ?? new Set<string>();
        for (const criterion of acceptance) ignored.add(frozenCriterionKey(criterion));
        ignoredMutationCriteria.set(key, ignored);
      } else if (!taskListContracts.has(key)) {
        taskListContracts.set(key, acceptance);
      }
    }
  }

  // Delegation acceptance is intentionally read only as corroborating audit
  // evidence. It never creates or replaces the earlier backend/task-list
  // authority used below.
  const corroboratingContracts = new Map<string, FrozenCriterionDefinition[]>();
  const delegationRows = db.prepare(`
    SELECT s.goal_id, d.task_id, d.acceptance
    FROM agent_delegation_requests d
    JOIN agent_sessions s ON s.id = d.parent_session_id
    WHERE d.role = 'worker' AND d.task_id IS NOT NULL AND d.acceptance IS NOT NULL
    ORDER BY d.created_at, d.rowid
  `).all() as Array<{ goal_id: string; task_id: string; acceptance: string }>;
  for (const row of delegationRows) {
    const key = managedTaskContractKey(row.goal_id, row.task_id);
    if (corroboratingContracts.has(key)) continue;
    try {
      const acceptance = parseFrozenCriteria(JSON.parse(row.acceptance));
      if (acceptance) corroboratingContracts.set(key, acceptance);
    } catch {
      // Malformed historical acceptance is retained as raw audit and cannot
      // become migration authority.
    }
  }

  let repairedTaskCount = 0;
  let removedCriterionCount = 0;
  let removedCriterionResultCount = 0;
  const ambiguousTasks = new Set<string>();
  const tasks = db.prepare(`
    SELECT id, goal_id, logical_task_id FROM managed_tasks ORDER BY goal_id, created_at, rowid
  `).all() as Array<{ id: string; goal_id: string; logical_task_id: string }>;

  for (const task of tasks) {
    const key = managedTaskContractKey(task.goal_id, task.logical_task_id);
    const ignored = ignoredMutationCriteria.get(key);
    if (!ignored || ignored.size === 0) continue;
    const current = db.prepare(`
      SELECT criterion_id AS id, text FROM managed_task_criteria WHERE task_id = ? ORDER BY rowid
    `).all(task.id) as FrozenCriterionDefinition[];
    const replayAdded = current.filter((criterion) => ignored.has(frozenCriterionKey(criterion)));
    if (replayAdded.length === 0) continue;

    const authoritative = syntheticContracts.get(key) ?? taskListContracts.get(key);
    const diagnosticId = `${task.goal_id}:${task.logical_task_id}`.slice(0, 300);
    if (!authoritative) {
      // A worker acceptance alone is never enough to select a frozen contract.
      void corroboratingContracts.get(key);
      ambiguousTasks.add(diagnosticId);
      continue;
    }
    const authoritativePairs = new Set(authoritative.map(frozenCriterionKey));
    const currentPairs = new Set(current.map(frozenCriterionKey));
    if (authoritative.some((criterion) => !currentPairs.has(frozenCriterionKey(criterion)))) {
      ambiguousTasks.add(diagnosticId);
      continue;
    }

    const removable = replayAdded.filter((criterion) => !authoritativePairs.has(frozenCriterionKey(criterion)));
    if (removable.length === 0) continue;
    const unattributedExtra = current.some((criterion) =>
      !authoritativePairs.has(frozenCriterionKey(criterion)) && !ignored.has(frozenCriterionKey(criterion)));
    if (unattributedExtra) ambiguousTasks.add(diagnosticId);
    for (const criterion of removable) {
      const result = db.prepare(`
        DELETE FROM managed_task_criterion_results WHERE task_id = ? AND criterion_id = ?
      `).run(task.id, criterion.id);
      removedCriterionResultCount += result.changes;
      const definition = db.prepare(`
        DELETE FROM managed_task_criteria WHERE task_id = ? AND criterion_id = ? AND text = ?
      `).run(task.id, criterion.id, criterion.text);
      removedCriterionCount += definition.changes;
    }
    if (removable.length > 0) repairedTaskCount += 1;
  }

  const sortedAmbiguousTasks = [...ambiguousTasks].sort();
  return {
    mode: "initialized_repair",
    repairedTaskCount,
    removedCriterionCount,
    removedCriterionResultCount,
    ambiguousTaskCount: sortedAmbiguousTasks.length,
    ambiguousTasks: sortedAmbiguousTasks.slice(0, 50),
    ambiguousTaskEnforcementIds: sortedAmbiguousTasks,
  };
}

interface SplitLineageMigrationDiagnostic {
  taskId: string;
  reasonCodes: string[];
}

interface SplitLineageRepairDetails extends Record<string, unknown> {
  mode: "initialized_repair";
  repairedParentCount: number;
  repairedParents: string[];
  ambiguousParentCount: number;
  ambiguousParents: SplitLineageMigrationDiagnostic[];
  frozenLineages: Array<{ goalId: string; parentTaskId: string; taskIds: string[] }>;
}

function repairManagedTaskSplitLineage(
  db: AppDatabase,
  beforeRowUpdate: () => void,
): SplitLineageRepairDetails {
  type TaskRow = {
    id: string;
    goal_id: string;
    logical_task_id: string;
    change_id: string | null;
    parent_task_id: string | null;
    status: string;
    attempt_count: number;
    substantive_rejection_count: number;
    created_at: string;
    updated_at: string;
    criterion_count: number;
  };
  const tasks = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM managed_task_criteria c WHERE c.task_id = t.id) AS criterion_count
    FROM managed_tasks t ORDER BY t.goal_id, t.created_at, t.rowid
  `).all() as TaskRow[];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const group = childrenByParent.get(task.parent_task_id) ?? [];
    group.push(task);
    childrenByParent.set(task.parent_task_id, group);
  }

  const announcements = new Map<string, Array<{ createdAt: string; childIds: string[] }>>();
  const events = db.prepare("SELECT goal_id, data, created_at FROM events ORDER BY created_at, rowid")
    .all() as Array<{ goal_id: string; data: string; created_at: string }>;
  for (const event of events) {
    const data = parseRecord(event.data);
    if (data?.runtimeEventType === "managed_task.lineage_split"
      && typeof data.parentTaskId === "string"
      && Array.isArray(data.taskIds)
      && data.taskIds.every((taskId) => typeof taskId === "string")) {
      const key = managedTaskContractKey(event.goal_id, data.parentTaskId);
      const records = announcements.get(key) ?? [];
      records.push({ createdAt: event.created_at, childIds: [...new Set(data.taskIds as string[])].sort() });
      announcements.set(key, records);
      continue;
    }
    if (data?.runtimeEventType !== "supervisor.task_list" || !Array.isArray(data.taskList)) continue;
    const grouped = new Map<string, string[]>();
    for (const rawTask of data.taskList) {
      const task = asRecord(rawTask);
      if (!task || typeof task.id !== "string" || typeof task.parentTaskId !== "string") continue;
      const group = grouped.get(task.parentTaskId) ?? [];
      group.push(task.id);
      grouped.set(task.parentTaskId, group);
    }
    for (const [parentId, childIds] of grouped) {
      const key = managedTaskContractKey(event.goal_id, parentId);
      const records = announcements.get(key) ?? [];
      records.push({ createdAt: event.created_at, childIds: [...new Set(childIds)].sort() });
      announcements.set(key, records);
    }
  }

  const repairs: TaskRow[] = [];
  const ambiguous: SplitLineageMigrationDiagnostic[] = [];
  const frozenLineages: Array<{ goalId: string; parentTaskId: string; taskIds: string[] }> = [];
  for (const parent of tasks) {
    const children = childrenByParent.get(parent.id) ?? [];
    if (children.length === 0) continue;
    const reasons = new Set<string>();
    if (parent.status === "delegated" || parent.status === "awaiting_review" || parent.status === "awaiting_delivery"
      || hasMigrationActivePipeline(db, parent)) {
      reasons.add("active_parent_pipeline");
    }
    if (parent.status !== "split" && !["rejected", "failed", "blocked"].includes(parent.status)
      && !reasons.has("active_parent_pipeline")) {
      reasons.add("ineligible_parent_status");
    }
    if (parent.status !== "split" && parent.substantive_rejection_count < 2 && parent.attempt_count < 3) {
      reasons.add("retry_threshold_not_reached");
    }
    if (children.some((child) => child.goal_id !== parent.goal_id)) reasons.add("cross_goal");
    if (children.some((child) => child.change_id !== parent.change_id)) reasons.add("cross_change");
    if (children.some((child) => child.criterion_count === 0 || parent.criterion_count === 0
      || child.criterion_count >= parent.criterion_count)) {
      reasons.add("child_contract_not_narrower");
    }
    if (lineageContainsCycle(parent, byId)) reasons.add("cycle");

    const expectedChildren = children.map((child) => child.logical_task_id).sort();
    const parentAnnouncements = announcements.get(managedTaskContractKey(parent.goal_id, parent.logical_task_id)) ?? [];
    const distinctAnnouncements = new Set(parentAnnouncements.map((announcement) => JSON.stringify(announcement.childIds)));
    const evidence = parentAnnouncements.find((announcement) => sameMigrationStrings(announcement.childIds, expectedChildren));
    if (!evidence) {
      reasons.add("missing_split_provenance");
    } else if (distinctAnnouncements.size !== 1) {
      reasons.add("ambiguous_split_provenance");
    } else {
      const firstChildAt = [...children].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]!.created_at;
      if (parent.updated_at > firstChildAt || children.some((child) => child.created_at > evidence.createdAt)) {
        reasons.add("ambiguous_chronology");
      }
    }

    if (reasons.size === 0) {
      frozenLineages.push({
        goalId: parent.goal_id,
        parentTaskId: parent.logical_task_id,
        taskIds: expectedChildren,
      });
      if (parent.status !== "split") repairs.push(parent);
    } else {
      ambiguous.push({
        taskId: `${parent.goal_id}:${parent.logical_task_id}`.slice(0, 300),
        reasonCodes: [...reasons].sort(),
      });
    }
  }

  if (repairs.length > 0) {
    beforeRowUpdate();
    const update = db.prepare("UPDATE managed_tasks SET status = 'split' WHERE id = ? AND status <> 'split'");
    for (const parent of repairs) update.run(parent.id);
  }
  const repairedParents = repairs
    .map((parent) => `${parent.goal_id}:${parent.logical_task_id}`.slice(0, 300))
    .sort();
  const sortedAmbiguous = ambiguous.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return {
    mode: "initialized_repair",
    repairedParentCount: repairedParents.length,
    repairedParents: repairedParents.slice(0, 50),
    ambiguousParentCount: sortedAmbiguous.length,
    ambiguousParents: sortedAmbiguous.slice(0, 50),
    frozenLineages: frozenLineages.sort((a, b) =>
      managedTaskContractKey(a.goalId, a.parentTaskId).localeCompare(managedTaskContractKey(b.goalId, b.parentTaskId))),
  };
}

function hasMigrationActivePipeline(
  db: AppDatabase,
  task: { id: string; goal_id: string; logical_task_id: string },
): boolean {
  if (db.prepare(`
    SELECT 1 FROM agent_delegation_requests d
    JOIN agent_sessions s ON s.id = d.parent_session_id
    WHERE s.goal_id = ? AND d.task_id = ? AND d.role = 'worker'
      AND d.status IN ('requested', 'accepted', 'running') LIMIT 1
  `).get(task.goal_id, task.logical_task_id)) return true;
  if (db.prepare("SELECT 1 FROM managed_task_reviews WHERE task_id = ? AND status = 'pending' LIMIT 1").get(task.id)) {
    return true;
  }
  if (db.prepare("SELECT 1 FROM managed_task_deliveries WHERE task_id = ? AND status = 'pending' LIMIT 1").get(task.id)) {
    return true;
  }
  return Boolean(db.prepare(`
    SELECT 1 FROM managed_task_integrations
    WHERE task_id = ? AND status NOT IN ('committed', 'rejected', 'blocked', 'resolution_failed', 'interrupted')
    LIMIT 1
  `).get(task.id));
}

function lineageContainsCycle<T extends { id: string; parent_task_id: string | null }>(
  start: T,
  byId: Map<string, T>,
): boolean {
  const seen = new Set<string>();
  let current: T | undefined = start;
  while (current) {
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    current = current.parent_task_id ? byId.get(current.parent_task_id) : undefined;
  }
  return false;
}

function sameMigrationStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseFrozenCriteria(value: unknown): FrozenCriterionDefinition[] | null {
  if (!Array.isArray(value)) return null;
  const criteria: FrozenCriterionDefinition[] = [];
  const ids = new Set<string>();
  for (const rawCriterion of value) {
    const criterion = asRecord(rawCriterion);
    if (!criterion || typeof criterion.id !== "string" || typeof criterion.text !== "string") return null;
    if (ids.has(criterion.id)) return null;
    ids.add(criterion.id);
    criteria.push({ id: criterion.id, text: criterion.text });
  }
  return criteria;
}

function managedTaskContractKey(goalId: string, logicalTaskId: string): string {
  return `${goalId}\u0000${logicalTaskId}`;
}

function frozenCriterionKey(criterion: FrozenCriterionDefinition): string {
  return `${criterion.id}\u0000${criterion.text}`;
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
