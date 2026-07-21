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
    "goal_input_requests",
    "goals",
    "managed_change_archive_operations",
    "managed_goal_recovery_authorizations",
    "managed_task_check_executions",
    "managed_task_criteria",
    "managed_task_criterion_results",
    "managed_task_deliveries",
    "managed_task_integrations",
    "managed_task_reviews",
    "managed_tasks",
    "provider_settings",
    "runs",
    "schema_migrations",
    "steps",
  ]);
  assert.deepEqual(columnNames(db, "goals"), [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "agent_type",
    "confirmation_policy",
    "workspace",
    "created_at",
    "updated_at",
    "started_at",
    "completed_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_tasks"), [
    "id", "goal_id", "logical_task_id", "change_id", "parent_task_id", "title", "status", "attempt_count",
    "substantive_rejection_count", "last_cited_criteria", "last_safe_summary", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_criteria"), [
    "task_id", "criterion_id", "text", "check_json", "outcome", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_criterion_results"), [
    "id", "task_id", "worker_delegation_request_id", "criterion_id", "executor_evidence",
    "judge_outcome", "judge_safe_summary", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_reviews"), [
    "id", "task_id", "worker_delegation_request_id", "judge_delegation_request_id", "integration_attempt_id",
    "reviewed_candidate_commit_sha", "status",
    "verdict", "decisions", "cited_criteria", "safe_summary", "deferred_findings", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_deliveries"), [
    "id", "task_id", "worker_delegation_request_id", "integration_attempt_id", "status", "checkpoint_head", "checkpoint_status",
    "candidate_commit_sha", "commit_sha", "validation_command", "validation_exit_code", "validation_summary",
    "rollback_summary", "safe_summary", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_task_integrations"), [
    "id", "task_id", "worker_delegation_request_id", "integrator_delegation_request_id", "status",
    "checkpoint_head", "original_candidate_commit_sha", "resolved_candidate_commit_sha", "conflict_files",
    "allowed_files", "safe_summary", "created_at", "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_change_archive_operations"), [
    "id", "goal_id", "change_id", "source_path", "target_path", "manifest_digest", "pre_archive_head",
    "status", "archive_commit_sha", "diagnostics", "operator_authorization_id", "created_at", "updated_at",
    "finalized_at",
  ]);
  assert.deepEqual(columnNames(db, "managed_goal_recovery_authorizations"), [
    "id", "goal_id", "plan_digest", "plan_json", "database_before_sha", "backup_sha",
    "workspace_path", "archive_commit_sha", "created_at",
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
    "provider_session_id",
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
  assert.deepEqual(columnNames(db, "schema_migrations"), [
    "name",
    "applied_at",
    "details",
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
    INSERT INTO goals VALUES ('live', 'Live', 'Historical', 'running', 'normal', 'managed', 'off', NULL, 't0', 't0', 't0', NULL);
    INSERT INTO runs VALUES ('run-live', 'live', 'running', 'mock', 'mock', 't0', NULL, NULL);
    INSERT INTO agent_sessions VALUES (
      'session-live', 'live', 'run-live', 'mock', 'mock', 'completed',
      '{"eventStreaming":true,"approval":false,"cancellation":true,"resume":false,"childSessions":true}',
      NULL, 't0', 't1', NULL, NULL
    );
    INSERT INTO events VALUES (
      'event-list', 'live', 'run-live', NULL, 'agent.progress', 'Tasks',
      '{"runtimeEventType":"supervisor.task_list","taskList":[{"id":"legacy-task","title":"Legacy","acceptance":[{"id":"A1","text":"Verified"}]}]}',
      't0'
    );
    INSERT INTO events VALUES (
      'event-ignored-list', 'live', 'run-live', NULL, 'agent.progress', 'Ignored restatement',
      '{"runtimeEventType":"supervisor.task_list","taskList":[{"id":"legacy-task","title":"Legacy restated","acceptance":[{"id":"B1","text":"Must not be replayed"}]}],"ignoredCriteriaMutations":["legacy-task"]}',
      't0.5'
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
    DROP TABLE IF EXISTS schema_migrations;
  `);
  db.close();

  db = openDatabase({ path: dbPath });
  const task = db.prepare(`
    SELECT status, attempt_count, last_safe_summary FROM managed_tasks WHERE logical_task_id = 'legacy-task'
  `)
    .get() as { status: string; attempt_count: number; last_safe_summary: string };
  assert.deepEqual(task, { status: "awaiting_review", attempt_count: 1, last_safe_summary: "Worker claimed success." });
  assert.deepEqual(db.prepare(`
    SELECT c.criterion_id, c.outcome FROM managed_task_criteria c
    JOIN managed_tasks t ON t.id = c.task_id WHERE t.logical_task_id = 'legacy-task'
    ORDER BY c.criterion_id
  `).all(), [{ criterion_id: "A1", outcome: "UNKNOWN" }]);
  assert.equal((db.prepare("SELECT attempt_number FROM agent_delegation_requests WHERE id = 'legacy-attempt'").get() as { attempt_number: number }).attempt_number, 1);
  assert.equal(migrationDetails(db, "managed-task-legacy-backfill-v1").mode, "legacy_backfill");
  const firstSnapshot = managedLedgerSnapshot(db);
  db.close();

  db = openDatabase({ path: dbPath });
  assert.deepEqual(managedLedgerSnapshot(db), firstSnapshot);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("records fresh managed-task migration baselines and reopen is a no-op", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "fresh-ledger.sqlite");
  let db = openDatabase({ path: dbPath });

  assert.equal(migrationDetails(db, "managed-task-legacy-backfill-v1").mode, "fresh_baseline");
  assert.equal(migrationDetails(db, "managed-task-frozen-contract-repair-v1").mode, "fresh_baseline");
  assert.equal(migrationDetails(db, "managed-task-split-lineage-repair-v1").mode, "fresh_baseline");
  const firstSnapshot = managedLedgerSnapshot(db);
  db.close();

  db = openDatabase({ path: dbPath });
  assert.deepEqual(managedLedgerSnapshot(db), firstSnapshot);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("records an initialized clean ledger without changing its authoritative rows", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "initialized-clean.sqlite");
  let db = openDatabase({ path: dbPath });
  db.exec(`
    INSERT INTO goals VALUES ('clean-goal', 'Clean', 'Initialized', 'running', 'normal', 'managed', 'off', NULL, 't0', 't0', 't0', NULL);
    INSERT INTO managed_tasks VALUES (
      'clean-task-db-id', 'clean-goal', 'clean-task', NULL, NULL, 'Clean task', 'registered', 0, 0, '[]', NULL, 't0', 't0'
    );
    INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at) VALUES ('clean-task-db-id', 'C1', 'Remains frozen.', 'UNKNOWN', 't0', 't0');
    DELETE FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1';
  `);
  const before = {
    tasks: db.prepare("SELECT * FROM managed_tasks").all(),
    criteria: db.prepare("SELECT * FROM managed_task_criteria").all(),
  };
  db.close();

  db = openDatabase({ path: dbPath });
  assert.deepEqual({
    tasks: db.prepare("SELECT * FROM managed_tasks").all(),
    criteria: db.prepare("SELECT * FROM managed_task_criteria").all(),
  }, before);
  assert.deepEqual(migrationDetails(db, "managed-task-frozen-contract-repair-v1"), {
    mode: "initialized_repair",
    repairedTaskCount: 0,
    removedCriterionCount: 0,
    removedCriterionResultCount: 0,
    ambiguousTaskCount: 0,
    ambiguousTasks: [],
    ambiguousTaskEnforcementIds: [],
  });
  const firstSnapshot = managedLedgerSnapshot(db);
  db.close();

  db = openDatabase({ path: dbPath });
  assert.deepEqual(managedLedgerSnapshot(db), firstSnapshot);
  db.close();
});

test("migration preserves completed, failed, cancelled, and blocked Goal lifecycle rows", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "auto-agent-db-")), "terminal-goals.sqlite");
  let db = openDatabase({ path: dbPath });
  for (const status of ["completed", "failed", "cancelled", "blocked"]) {
    db.prepare(`
      INSERT INTO goals VALUES (?, ?, 'Terminal', ?, 'normal', 'managed', 'off', NULL, 't0', 't9', 't1', 't9')
    `).run(`goal-${status}`, status, status);
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'mock', 'mock', 't1', 't9', ?)")
      .run(`run-${status}`, `goal-${status}`, status === "completed" ? "completed" : "failed", status);
    db.prepare(`
      INSERT INTO agent_sessions VALUES (?, ?, ?, 'mock', 'mock', 'completed',
        '{"eventStreaming":true,"approval":false,"cancellation":true,"resume":false,"childSessions":true}',
        NULL, 't1', 't9', NULL, NULL)
    `).run(`session-${status}`, `goal-${status}`, `run-${status}`);
    db.prepare("INSERT INTO events VALUES (?, ?, ?, NULL, 'goal.blocked', ?, '{}', 't9')")
      .run(`event-${status}`, `goal-${status}`, `run-${status}`, status);
  }
  db.prepare("DELETE FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'").run();
  const before = Object.fromEntries(
    ["completed", "failed", "cancelled", "blocked"].map((status) => [status, goalLifecycleSnapshot(db, `goal-${status}`)]),
  );
  const eventCount = db.prepare("SELECT COUNT(*) FROM events").pluck().get();
  db.close();

  db = openDatabase({ path: dbPath });
  const after = Object.fromEntries(
    ["completed", "failed", "cancelled", "blocked"].map((status) => [status, goalLifecycleSnapshot(db, `goal-${status}`)]),
  );
  assert.deepEqual(after, before);
  assert.equal(db.prepare("SELECT COUNT(*) FROM events").pluck().get(), eventCount);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("repairs only proven ignored synthetic criteria and preserves blocked lifecycle and raw audit", () => {
  const fixture = createFrozenContractFixture({ blocked: true });
  let db = openDatabase({ path: fixture.path });

  assert.deepEqual(
    db.prepare(`
      SELECT c.criterion_id, c.text, c.outcome
      FROM managed_task_criteria c JOIN managed_tasks t ON t.id = c.task_id
      WHERE t.goal_id = ? AND t.logical_task_id = 'spec:change-one'
      ORDER BY c.criterion_id
    `).all(fixture.goalId),
    [
      { criterion_id: "S1", text: "Proposal is complete.", outcome: "PASS" },
      { criterion_id: "S2", text: "Delta specs are complete.", outcome: "PASS" },
      { criterion_id: "S3", text: "Tasks are complete.", outcome: "PASS" },
    ],
  );
  assert.equal((db.prepare("SELECT COUNT(*) FROM managed_task_criterion_results WHERE criterion_id = 'A1'").pluck().get() as number), 0);
  assert.deepEqual(goalLifecycleSnapshot(db, fixture.goalId), fixture.goalSnapshot);
  assert.deepEqual(rawAuditSnapshot(db, fixture.goalId), fixture.auditSnapshot);
  assert.deepEqual(migrationDetails(db, "managed-task-frozen-contract-repair-v1"), {
    mode: "initialized_repair",
    repairedTaskCount: 1,
    removedCriterionCount: 2,
    removedCriterionResultCount: 1,
    ambiguousTaskCount: 0,
    ambiguousTasks: [],
    ambiguousTaskEnforcementIds: [],
  });
  const firstSnapshot = managedLedgerSnapshot(db);
  db.close();

  db = openDatabase({ path: fixture.path });
  assert.deepEqual(managedLedgerSnapshot(db), firstSnapshot);
  assert.deepEqual(goalLifecycleSnapshot(db, fixture.goalId), fixture.goalSnapshot);
  assert.deepEqual(rawAuditSnapshot(db, fixture.goalId), fixture.auditSnapshot);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("leaves ambiguous historical criteria fail-closed with a bounded durable diagnostic", () => {
  const fixture = createFrozenContractFixture({ ambiguous: true });
  let db = openDatabase({ path: fixture.path });

  assert.deepEqual(
    db.prepare(`
      SELECT c.criterion_id, c.outcome
      FROM managed_task_criteria c JOIN managed_tasks t ON t.id = c.task_id
      WHERE t.goal_id = ? ORDER BY c.criterion_id
    `).all(fixture.goalId),
    [
      { criterion_id: "A1", outcome: "UNKNOWN" },
      { criterion_id: "A2", outcome: "UNKNOWN" },
    ],
  );
  const diagnostic = migrationDetails(db, "managed-task-frozen-contract-repair-v1");
  assert.equal(diagnostic.repairedTaskCount, 0);
  assert.equal(diagnostic.ambiguousTaskCount, 1);
  assert.deepEqual(diagnostic.ambiguousTasks, [`${fixture.goalId}:ordinary-task`]);
  assert.deepEqual(diagnostic.ambiguousTaskEnforcementIds, [`${fixture.goalId}:ordinary-task`]);
  const firstSnapshot = managedLedgerSnapshot(db);
  db.close();

  db = openDatabase({ path: fixture.path });
  assert.deepEqual(managedLedgerSnapshot(db), firstSnapshot);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("keeps complete frozen-contract enforcement identity beyond bounded migration diagnostics", () => {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-db-bounded-contract-")), "repair.sqlite");
  const goalId = "bounded-contract-goal";
  const logicalTaskIds = Array.from({ length: 51 }, (_, index) =>
    `ambiguous-${String(index + 1).padStart(3, "0")}`
  );
  let db = openDatabase({ path });
  db.prepare(`
    INSERT INTO goals (
      id, title, description, status, priority, agent_type, confirmation_policy, workspace, created_at, updated_at, started_at, completed_at
    ) VALUES (?, 'Bounded diagnostic', 'Complete enforcement identity', 'running', 'normal', 'managed', 'off', NULL,
      't0', 't0', 't0', NULL)
  `).run(goalId);
  const insertTask = db.prepare(`
    INSERT INTO managed_tasks (
      id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
      substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
    ) VALUES (?, ?, ?, 'change-one', NULL, ?, 'accepted', 1, 0, '[]', 'Historical pass', 't1', 't2')
  `);
  const insertCriterion = db.prepare(`
    INSERT INTO managed_task_criteria (
      task_id, criterion_id, text, outcome, created_at, updated_at
    ) VALUES (?, 'A1', 'Guessed criterion.', 'PASS', 't1', 't2')
  `);
  for (const logicalTaskId of logicalTaskIds) {
    const databaseTaskId = `db-${logicalTaskId}`;
    insertTask.run(databaseTaskId, goalId, logicalTaskId, logicalTaskId);
    insertCriterion.run(databaseTaskId);
  }
  db.prepare(`
    INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at)
    VALUES ('bounded-contract-event', ?, NULL, NULL, 'agent.progress', 'Ignored restatement', ?, 't2')
  `).run(goalId, JSON.stringify({
    runtimeEventType: "supervisor.task_list",
    taskList: logicalTaskIds.map((id) => ({
      id,
      title: id,
      acceptance: [{ id: "A1", text: "Guessed criterion." }],
    })),
    ignoredCriteriaMutations: logicalTaskIds,
  }));
  db.prepare("DELETE FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'").run();
  db.close();

  db = openDatabase({ path });
  const diagnostic = migrationDetails(db, "managed-task-frozen-contract-repair-v1");
  const targetIdentity = `${goalId}:ambiguous-051`;
  assert.equal(diagnostic.ambiguousTaskCount, 51);
  assert.equal((diagnostic.ambiguousTasks as unknown[]).length, 50);
  assert.equal((diagnostic.ambiguousTasks as string[]).includes(targetIdentity), false);
  assert.equal((diagnostic.ambiguousTaskEnforcementIds as unknown[]).length, 51);
  assert.equal((diagnostic.ambiguousTaskEnforcementIds as string[]).includes(targetIdentity), true);
  assert.deepEqual(db.prepare(`
    SELECT t.status, c.outcome FROM managed_tasks t
    JOIN managed_task_criteria c ON c.task_id = t.id
    WHERE t.goal_id = ? AND t.logical_task_id = 'ambiguous-051'
  `).get(goalId), { status: "accepted", outcome: "PASS" });
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("rolls migration effects and marker back together when marker insertion fails", () => {
  const fixture = createFrozenContractFixture({});
  const before = new Database(fixture.path);
  before.exec(`
    CREATE TRIGGER fail_frozen_contract_marker
    BEFORE INSERT ON schema_migrations
    WHEN NEW.name = 'managed-task-frozen-contract-repair-v1'
    BEGIN
      SELECT RAISE(ABORT, 'simulated marker failure');
    END;
  `);
  before.close();

  assert.throws(() => openDatabase({ path: fixture.path }), /simulated marker failure/);
  const failed = new Database(fixture.path);
  assert.equal(failed.prepare(`
    SELECT COUNT(*) FROM managed_task_criteria c JOIN managed_tasks t ON t.id = c.task_id
    WHERE t.goal_id = ? AND c.criterion_id IN ('A1', 'A2')
  `).pluck().get(fixture.goalId), 2);
  assert.equal(failed.prepare("SELECT COUNT(*) FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'").pluck().get(), 0);
  failed.exec("DROP TRIGGER fail_frozen_contract_marker");
  failed.close();

  const recovered = openDatabase({ path: fixture.path });
  assert.equal(recovered.prepare(`
    SELECT COUNT(*) FROM managed_task_criteria c JOIN managed_tasks t ON t.id = c.task_id
    WHERE t.goal_id = ? AND c.criterion_id IN ('A1', 'A2')
  `).pluck().get(fixture.goalId), 0);
  assert.equal(recovered.prepare("SELECT COUNT(*) FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'").pluck().get(), 1);
  assert.deepEqual(recovered.pragma("foreign_key_check"), []);
  recovered.close();
});

test("repairs only provable historical split lineages and records bounded ambiguity", () => {
  const fixture = createSplitLineageMigrationFixture();
  const rawBefore = new Database(fixture.path, { readonly: true });
  const lifecycleBefore = goalLifecycleSnapshot(rawBefore as ReturnType<typeof openDatabase>, "goal-terminal");
  const auditBefore = rawAuditSnapshot(rawBefore as ReturnType<typeof openDatabase>, "goal-terminal");
  rawBefore.close();

  let db = openDatabase({ path: fixture.path });

  const statuses = db.prepare(`
    SELECT goal_id, logical_task_id, status FROM managed_tasks
    WHERE logical_task_id LIKE 'parent-%' ORDER BY goal_id
  `).all() as Array<{ goal_id: string; logical_task_id: string; status: string }>;
  assert.deepEqual(statuses.map((row) => [row.goal_id, row.status]), [
    ["goal-active", "delegated"],
    ["goal-ambiguous", "rejected"],
    ["goal-cross-change", "rejected"],
    ["goal-cycle", "rejected"],
    ["goal-non-narrower", "rejected"],
    ["goal-post-evidence-child", "rejected"],
    ["goal-repairable", "split"],
    ["goal-terminal", "split"],
    ["goal-valid", "split"],
  ]);
  const details = migrationDetails(db, "managed-task-split-lineage-repair-v1");
  assert.equal(details.mode, "initialized_repair");
  assert.equal(details.repairedParentCount, 2);
  assert.deepEqual(details.repairedParents, ["goal-repairable:parent-repairable", "goal-terminal:parent-terminal"]);
  assert.deepEqual(details.frozenLineages, [
    { goalId: "goal-repairable", parentTaskId: "parent-repairable", taskIds: ["child-repairable"] },
    { goalId: "goal-terminal", parentTaskId: "parent-terminal", taskIds: ["child-terminal"] },
    { goalId: "goal-valid", parentTaskId: "parent-valid", taskIds: ["child-valid"] },
  ]);
  assert.equal(details.ambiguousParentCount, 7);
  const ambiguous = new Map(
    (details.ambiguousParents as Array<{ taskId: string; reasonCodes: string[] }>)
      .map((entry) => [entry.taskId, entry.reasonCodes]),
  );
  assert.ok(ambiguous.get("goal-active:parent-active")?.includes("active_parent_pipeline"));
  assert.ok(ambiguous.get("goal-ambiguous:parent-ambiguous")?.includes("ambiguous_chronology"));
  assert.ok(ambiguous.get("goal-cross-change:parent-cross-change")?.includes("cross_change"));
  assert.ok(ambiguous.get("goal-cycle:parent-cycle")?.includes("cycle"));
  assert.ok(ambiguous.get("goal-cycle:child-cycle")?.includes("cycle"));
  assert.ok(ambiguous.get("goal-non-narrower:parent-non-narrower")?.includes("child_contract_not_narrower"));
  assert.ok(ambiguous.get("goal-post-evidence-child:parent-post-evidence-child")?.includes("ambiguous_chronology"));
  assert.deepEqual(goalLifecycleSnapshot(db, "goal-terminal"), lifecycleBefore);
  assert.deepEqual(rawAuditSnapshot(db, "goal-terminal"), auditBefore);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  const firstSnapshot = managedLedgerSnapshot(db);
  db.close();

  db = openDatabase({ path: fixture.path });
  assert.deepEqual(managedLedgerSnapshot(db), firstSnapshot);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("split-lineage migration marker and repair roll back at every injected fault window", () => {
  for (const point of ["before_row_update", "before_marker_insert"] as const) {
    const fixture = createSplitLineageMigrationFixture();

    assert.throws(() => openDatabase({
      path: fixture.path,
      migrationFault(name, actualPoint) {
        if (name === "managed-task-split-lineage-repair-v1" && actualPoint === point) {
          throw new Error(`injected ${point}`);
        }
      },
    }), new RegExp(`injected ${point}`));

    const failed = new Database(fixture.path, { readonly: true });
    assert.equal(failed.prepare(`
      SELECT status FROM managed_tasks WHERE goal_id = 'goal-repairable' AND logical_task_id = 'parent-repairable'
    `).pluck().get(), "rejected");
    assert.equal(failed.prepare(`
      SELECT COUNT(*) FROM schema_migrations WHERE name = 'managed-task-split-lineage-repair-v1'
    `).pluck().get(), 0);
    failed.close();

    const recovered = openDatabase({ path: fixture.path });
    assert.equal(recovered.prepare(`
      SELECT status FROM managed_tasks WHERE goal_id = 'goal-repairable' AND logical_task_id = 'parent-repairable'
    `).pluck().get(), "split");
    assert.equal(recovered.prepare(`
      SELECT COUNT(*) FROM schema_migrations WHERE name = 'managed-task-split-lineage-repair-v1'
    `).pluck().get(), 1);
    recovered.close();
  }

  const committedFixture = createSplitLineageMigrationFixture();
  assert.throws(() => openDatabase({
    path: committedFixture.path,
    migrationFault(name, point) {
      if (name === "managed-task-split-lineage-repair-v1" && point === "after_commit") {
        throw new Error("injected after_commit");
      }
    },
  }), /injected after_commit/);
  const committed = new Database(committedFixture.path, { readonly: true });
  assert.equal(committed.prepare(`
    SELECT status FROM managed_tasks WHERE goal_id = 'goal-repairable' AND logical_task_id = 'parent-repairable'
  `).pluck().get(), "split");
  assert.equal(committed.prepare(`
    SELECT COUNT(*) FROM schema_migrations WHERE name = 'managed-task-split-lineage-repair-v1'
  `).pluck().get(), 1);
  committed.close();
  const reopened = openDatabase({ path: committedFixture.path });
  assert.equal(reopened.prepare(`
    SELECT COUNT(*) FROM schema_migrations WHERE name = 'managed-task-split-lineage-repair-v1'
  `).pluck().get(), 1);
  reopened.close();
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

function createFrozenContractFixture(options: { blocked?: boolean; ambiguous?: boolean }): {
  path: string;
  goalId: string;
  goalSnapshot: unknown;
  auditSnapshot: unknown;
} {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-db-repair-")), "repair.sqlite");
  const db = openDatabase({ path });
  db.exec(`
    INSERT INTO goals VALUES (
      'repair-goal', 'Repair', 'Historical', '${options.blocked ? "blocked" : "running"}', 'normal', 'managed', 'off', NULL,
      't0', 't9', 't1', ${options.blocked ? "'t9'" : "NULL"}
    );
    INSERT INTO runs VALUES ('repair-run', 'repair-goal', '${options.blocked ? "failed" : "running"}', 'mock', 'mock', 't1', ${options.blocked ? "'t9'" : "NULL"}, ${options.blocked ? "'continuations exhausted'" : "NULL"});
    INSERT INTO agent_sessions VALUES (
      'repair-session', 'repair-goal', 'repair-run', 'mock', 'mock', 'completed',
      '{"eventStreaming":true,"approval":false,"cancellation":true,"resume":false,"childSessions":true}',
      NULL, 't1', 't8', NULL, NULL
    );
    INSERT INTO managed_tasks (
      id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
      substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
    ) VALUES (
      'repair-task-db-id', 'repair-goal', '${options.ambiguous ? "ordinary-task" : "spec:change-one"}',
      ${options.ambiguous ? "NULL" : "'change-one'"}, NULL, 'Frozen task', '${options.ambiguous ? "registered" : "accepted"}',
      ${options.ambiguous ? 0 : 1}, 0, '[]', 'Historical task', 't2', 't8'
    );
  `);

  if (!options.ambiguous) {
    db.exec(`
      INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at) VALUES
        ('repair-task-db-id', 'S1', 'Proposal is complete.', 'PASS', 't2', 't7'),
        ('repair-task-db-id', 'S2', 'Delta specs are complete.', 'PASS', 't2', 't7'),
        ('repair-task-db-id', 'S3', 'Tasks are complete.', 'PASS', 't2', 't7');
      INSERT INTO events VALUES (
        'plan-event', 'repair-goal', 'repair-run', NULL, 'agent.progress', 'Plan',
        '{"runtimeEventType":"supervisor.change_plan","changePlan":[{"id":"change-one","title":"One","rationale":"R"}],"specTasks":[{"taskId":"spec:change-one","changeId":"change-one","acceptance":[{"id":"S1","text":"Proposal is complete."},{"id":"S2","text":"Delta specs are complete."},{"id":"S3","text":"Tasks are complete."}]}]}',
        't2'
      );
    `);
  }

  db.exec(`
    INSERT INTO events VALUES (
      'ignored-event', 'repair-goal', 'repair-run', NULL, 'agent.progress', 'Restated',
      '{"runtimeEventType":"supervisor.task_list","taskList":[{"id":"${options.ambiguous ? "ordinary-task" : "spec:change-one"}","title":"Restated","acceptance":[{"id":"A1","text":"Guessed criterion one."},{"id":"A2","text":"Guessed criterion two."}]}],"ignoredCriteriaMutations":["${options.ambiguous ? "ordinary-task" : "spec:change-one"}"]}',
      't3'
    );
    INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at) VALUES
      ('repair-task-db-id', 'A1', 'Guessed criterion one.', 'UNKNOWN', 't3', 't3'),
      ('repair-task-db-id', 'A2', 'Guessed criterion two.', 'UNKNOWN', 't3', 't3');
  `);

  if (!options.ambiguous) {
    db.exec(`
      INSERT INTO agent_delegation_requests (
        id, parent_session_id, child_session_id, role, status, prompt_summary, task_id, change_id, acceptance,
        result_summary, detached_reason, created_at, updated_at, accepted_at, started_at, completed_at, attempt_number
      ) VALUES (
        'repair-worker', 'repair-session', NULL, 'worker', 'completed', 'Worker', 'spec:change-one', 'change-one',
        '[{"id":"S1","text":"Proposal is complete."},{"id":"S2","text":"Delta specs are complete."},{"id":"S3","text":"Tasks are complete."}]',
        '{"kind":"success","safeSummary":"Historical result","attestedFiles":["proposal.md"]}', NULL,
        't4', 't5', 't4', 't4', 't5', 1
      );
      INSERT INTO managed_task_criterion_results VALUES (
        'polluted-result', 'repair-task-db-id', 'repair-worker', 'A1', 'Claim', NULL, NULL, 't5', 't5'
      );
      INSERT INTO managed_task_reviews (
        id, task_id, worker_delegation_request_id, judge_delegation_request_id, integration_attempt_id,
        reviewed_candidate_commit_sha, status, verdict, decisions, cited_criteria, safe_summary,
        deferred_findings, created_at, updated_at
      ) VALUES (
        'repair-review', 'repair-task-db-id', 'repair-worker', NULL, NULL, 'candidate-one', 'accepted', 'accepted',
        '[]', '[]', 'Historical review', '[]', 't6', 't6'
      );
    `);
  }

  if (tableNames(db).includes("schema_migrations")) {
    db.prepare("DELETE FROM schema_migrations WHERE name = 'managed-task-frozen-contract-repair-v1'").run();
  }
  const goalSnapshot = goalLifecycleSnapshot(db, "repair-goal");
  const auditSnapshot = rawAuditSnapshot(db, "repair-goal");
  db.close();
  return { path, goalId: "repair-goal", goalSnapshot, auditSnapshot };
}

function createSplitLineageMigrationFixture(): { path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-db-lineage-repair-")), "repair.sqlite");
  const db = openDatabase({ path });
  const insertGoal = db.prepare(`
    INSERT INTO goals VALUES (?, ?, 'Historical lineage', ?, 'normal', 'managed', 'off', NULL, 't0', 't9', 't1', ?)
  `);
  const insertTask = db.prepare(`
    INSERT INTO managed_tasks (
      id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
      substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
  `);
  const insertCriterion = db.prepare(`
    INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at) VALUES (?, ?, ?, 'UNKNOWN', ?, ?)
  `);
  const scenarios = [
    { goal: "goal-repairable", parent: "parent-repairable", status: "rejected", updated: "t2", child: "child-repairable", childChange: "change-a", childCriteria: 1 },
    { goal: "goal-terminal", parent: "parent-terminal", status: "rejected", updated: "t2", child: "child-terminal", childChange: "change-a", childCriteria: 1, terminal: true },
    { goal: "goal-valid", parent: "parent-valid", status: "split", updated: "t2", child: "child-valid", childChange: "change-a", childCriteria: 1, runtimeEvidence: true },
    { goal: "goal-ambiguous", parent: "parent-ambiguous", status: "rejected", updated: "t8", child: "child-ambiguous", childChange: "change-a", childCriteria: 1 },
    { goal: "goal-non-narrower", parent: "parent-non-narrower", status: "rejected", updated: "t2", child: "child-non-narrower", childChange: "change-a", childCriteria: 2 },
    { goal: "goal-post-evidence-child", parent: "parent-post-evidence-child", status: "rejected", updated: "t2", child: "child-before-evidence", lateChild: "child-after-evidence", childChange: "change-a", childCriteria: 1 },
    { goal: "goal-cross-change", parent: "parent-cross-change", status: "rejected", updated: "t2", child: "child-cross-change", childChange: "change-b", childCriteria: 1 },
    { goal: "goal-active", parent: "parent-active", status: "delegated", updated: "t2", child: "child-active", childChange: "change-a", childCriteria: 1 },
    { goal: "goal-cycle", parent: "parent-cycle", status: "rejected", updated: "t2", child: "child-cycle", childChange: "change-a", childCriteria: 1, cycle: true },
  ] as const;
  for (const scenario of scenarios) {
    insertGoal.run(
      scenario.goal,
      scenario.goal,
      "terminal" in scenario && scenario.terminal ? "blocked" : "running",
      "terminal" in scenario && scenario.terminal ? "t9" : null,
    );
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'mock', 'mock', 't1', ?, ?)").run(
      `${scenario.goal}-run`, scenario.goal,
      "terminal" in scenario && scenario.terminal ? "failed" : "completed",
      "terminal" in scenario && scenario.terminal ? "t9" : "t2",
      "terminal" in scenario && scenario.terminal ? "continuations exhausted" : null,
    );
    db.prepare(`
      INSERT INTO agent_sessions VALUES (
        ?, ?, ?, 'mock', 'mock', 'completed',
        '{"eventStreaming":true,"approval":false,"cancellation":true,"resume":false,"childSessions":true}',
        NULL, 't1', 't2', NULL, NULL
      )
    `).run(`${scenario.goal}-session`, scenario.goal, `${scenario.goal}-run`);
    const parentDbId = `${scenario.parent}-db`;
    const childDbId = `${scenario.child}-db`;
    insertTask.run(
      parentDbId, scenario.goal, scenario.parent, "change-a", null, "Parent", scenario.status,
      2, 2, "Historical parent", "t1", scenario.updated,
    );
    insertCriterion.run(parentDbId, "P1", "First", "t1", "t2");
    insertCriterion.run(parentDbId, "P2", "Second", "t1", "t2");
    insertTask.run(
      childDbId, scenario.goal, scenario.child, scenario.childChange, parentDbId, "Child", "accepted",
      1, 0, "Historical child", "t3", "t4",
    );
    for (let index = 0; index < scenario.childCriteria; index += 1) {
      insertCriterion.run(childDbId, `C${index + 1}`, `Child ${index + 1}`, "t3", "t4");
    }
    if ("lateChild" in scenario) {
      const lateChildDbId = `${scenario.lateChild}-db`;
      insertTask.run(
        lateChildDbId, scenario.goal, scenario.lateChild, scenario.childChange, parentDbId, "Late child", "accepted",
        1, 0, "Historical child created after split evidence", "t6", "t6",
      );
      insertCriterion.run(lateChildDbId, "C1", "Late child", "t6", "t6");
    }
    if ("cycle" in scenario && scenario.cycle) {
      db.prepare("UPDATE managed_tasks SET parent_task_id = ? WHERE id = ?").run(childDbId, parentDbId);
    }
    const runtimeEvidence = "runtimeEvidence" in scenario && scenario.runtimeEvidence;
    db.prepare(`
      INSERT INTO events VALUES (?, ?, NULL, NULL, 'agent.progress', 'Historical task list', ?, ?)
    `).run(
      `${scenario.goal}-task-list`, scenario.goal,
      JSON.stringify(runtimeEvidence ? {
        runtimeEventType: "managed_task.lineage_split",
        parentTaskId: scenario.parent,
        taskIds: [scenario.child],
        reasonCode: "retry_threshold_reached",
      } : {
        runtimeEventType: "supervisor.task_list",
        changeId: scenario.childChange,
        taskList: [
          { id: scenario.child, parentTaskId: scenario.parent },
          ...("lateChild" in scenario ? [{ id: scenario.lateChild, parentTaskId: scenario.parent }] : []),
        ],
      }),
      runtimeEvidence ? "t3" : "t5",
    );
  }
  db.prepare("DELETE FROM schema_migrations WHERE name = 'managed-task-split-lineage-repair-v1'").run();
  db.close();
  return { path };
}

function migrationDetails(db: ReturnType<typeof openDatabase>, name: string): Record<string, unknown> {
  const row = db.prepare("SELECT details FROM schema_migrations WHERE name = ?").get(name) as { details: string } | undefined;
  assert.ok(row, `missing migration marker ${name}`);
  return JSON.parse(row.details) as Record<string, unknown>;
}

function managedLedgerSnapshot(db: ReturnType<typeof openDatabase>): unknown {
  return {
    migrations: db.prepare("SELECT name, applied_at, details FROM schema_migrations ORDER BY name").all(),
    tasks: db.prepare("SELECT * FROM managed_tasks ORDER BY id").all(),
    criteria: db.prepare("SELECT * FROM managed_task_criteria ORDER BY task_id, criterion_id").all(),
    results: db.prepare("SELECT * FROM managed_task_criterion_results ORDER BY id").all(),
    attempts: db.prepare("SELECT id, attempt_number FROM agent_delegation_requests ORDER BY id").all(),
  };
}

function goalLifecycleSnapshot(db: ReturnType<typeof openDatabase>, goalId: string): unknown {
  return {
    goal: db.prepare("SELECT status, updated_at, started_at, completed_at FROM goals WHERE id = ?").get(goalId),
    runs: db.prepare("SELECT id, status, started_at, finished_at, error FROM runs WHERE goal_id = ? ORDER BY id").all(goalId),
    sessions: db.prepare("SELECT id, lifecycle_state, created_at, last_activity_at FROM agent_sessions WHERE goal_id = ? ORDER BY id").all(goalId),
  };
}

function rawAuditSnapshot(db: ReturnType<typeof openDatabase>, goalId: string): unknown {
  return {
    events: db.prepare("SELECT id, data FROM events WHERE goal_id = ? ORDER BY id").all(goalId),
    delegations: db.prepare(`
      SELECT d.id, d.acceptance, d.result_summary FROM agent_delegation_requests d
      JOIN agent_sessions s ON s.id = d.parent_session_id WHERE s.goal_id = ? ORDER BY d.id
    `).all(goalId),
    reviews: db.prepare(`
      SELECT r.id, r.decisions, r.safe_summary FROM managed_task_reviews r
      JOIN managed_tasks t ON t.id = r.task_id WHERE t.goal_id = ? ORDER BY r.id
    `).all(goalId),
  };
}
