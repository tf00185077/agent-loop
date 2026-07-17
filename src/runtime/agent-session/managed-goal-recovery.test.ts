import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { AgentRuntimeAdapter } from "../../domain/index.js";
import { openDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { recoverManagedGoal } from "./managed-goal-recovery.js";

test("offline recovery dry-run is byte-stable and apply adopts one proven archive transactionally", () => {
  const fixture = eligibleRecoveryFixture();
  const before = sha256(fixture.databasePath);

  const first = recoverManagedGoal({
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    goalId: fixture.goalId,
  });
  const second = recoverManagedGoal({
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    goalId: fixture.goalId,
  });

  assert.equal(first.eligible, true, first.blockers.join("; "));
  assert.equal(first.applied, false);
  assert.deepEqual(second, first);
  assert.equal(sha256(fixture.databasePath), before);
  assert.deepEqual(first.actions.map((action) => action.type), ["adopt_archive", "interrupt_goal"]);

  const applied = recoverManagedGoal({
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    goalId: fixture.goalId,
    apply: true,
    planDigest: first.planDigest,
    backupPath: fixture.backupPath,
    stoppedEvidencePath: fixture.stoppedEvidencePath,
  });
  assert.equal(applied.eligible, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.idempotent, false);

  const db = openDatabase({ path: fixture.databasePath });
  assert.deepEqual(db.prepare("SELECT status, completed_at FROM goals WHERE id = ?").get(fixture.goalId), {
    status: "interrupted", completed_at: null,
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM managed_goal_recovery_authorizations WHERE goal_id = ? AND plan_digest = ?
  `).pluck().get(fixture.goalId, first.planDigest), 1);
  assert.deepEqual(db.prepare(`
    SELECT status, archive_commit_sha, operator_authorization_id IS NOT NULL AS authorized
    FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = 'change-one'
  `).get(fixture.goalId), {
    status: "committed", archive_commit_sha: fixture.archiveCommitSha, authorized: 1,
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM events
    WHERE goal_id = ? AND json_extract(data, '$.runtimeEventType') = 'change.archived'
  `).pluck().get(fixture.goalId), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM agent_sessions WHERE goal_id = ?").pluck().get(fixture.goalId), 1);
  db.close();

  const replay = recoverManagedGoal({
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    goalId: fixture.goalId,
    apply: true,
    planDigest: first.planDigest,
    backupPath: fixture.backupPath,
    stoppedEvidencePath: fixture.stoppedEvidencePath,
  });
  assert.equal(replay.applied, true);
  assert.equal(replay.idempotent, true);
});

test("idempotent recovery replay fails closed when durable recovery postconditions were tampered or partially restored", () => {
  const scenarios: Array<{
    name: string;
    blocker: RegExp;
    mutate: (db: ReturnType<typeof openDatabase>, goalId: string) => void;
  }> = [
    {
      name: "goal reverted",
      blocker: /recovery_goal_postcondition_mismatch/,
      mutate(db, goalId) {
        db.prepare("UPDATE goals SET status = 'blocked' WHERE id = ?").run(goalId);
      },
    },
    {
      name: "archive sha tampered",
      blocker: /recovery_archive_postcondition_mismatch/,
      mutate(db, goalId) {
        db.prepare("UPDATE managed_change_archive_operations SET archive_commit_sha = 'tampered' WHERE goal_id = ?")
          .run(goalId);
      },
    },
    {
      name: "archive event missing",
      blocker: /recovery_archive_event_count_mismatch/,
      mutate(db, goalId) {
        db.prepare(`DELETE FROM events WHERE goal_id = ?
          AND json_extract(data, '$.runtimeEventType') = 'change.archived'`).run(goalId);
      },
    },
    {
      name: "archive event duplicated",
      blocker: /recovery_archive_event_count_mismatch/,
      mutate(db, goalId) {
        db.prepare(`
          INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at)
          SELECT 'duplicate-recovery-archive-event', goal_id, run_id, step_id, type, message, data, created_at
          FROM events WHERE goal_id = ?
            AND json_extract(data, '$.runtimeEventType') = 'change.archived'
        `).run(goalId);
      },
    },
    {
      name: "archive event cross links removed",
      blocker: /recovery_archive_event_postcondition_mismatch/,
      mutate(db, goalId) {
        db.prepare(`UPDATE events SET data = json_remove(data, '$.operatorAuthorizationId', '$.archiveOperationId')
          WHERE goal_id = ? AND json_extract(data, '$.runtimeEventType') = 'change.archived'`).run(goalId);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = eligibleRecoveryFixture();
    const dryRun = recoverManagedGoal({
      databasePath: fixture.databasePath, workspacePath: fixture.workspacePath, goalId: fixture.goalId,
    });
    const applyInput = {
      databasePath: fixture.databasePath,
      workspacePath: fixture.workspacePath,
      goalId: fixture.goalId,
      apply: true,
      planDigest: dryRun.planDigest,
      backupPath: fixture.backupPath,
      stoppedEvidencePath: fixture.stoppedEvidencePath,
    } as const;
    const applied = recoverManagedGoal(applyInput);
    assert.equal(applied.applied, true, scenario.name);
    const db = openDatabase({ path: fixture.databasePath });
    scenario.mutate(db, fixture.goalId);
    db.close();
    const beforeReplay = sha256(fixture.databasePath);

    const replay = recoverManagedGoal(applyInput);

    assert.equal(replay.eligible, false, scenario.name);
    assert.equal(replay.applied, false, scenario.name);
    assert.equal(replay.idempotent, false, scenario.name);
    assert.match(replay.blockers.join(";"), scenario.blocker, scenario.name);
    assert.equal(sha256(fixture.databasePath), beforeReplay, scenario.name);
  }
});

test("idempotent recovery replay revalidates the authorized archive workspace", async (t) => {
  const scenarios: Array<{
    name: string;
    blocker: RegExp;
    mutate: (fixture: RecoveryFixture) => void;
  }> = [
    {
      name: "archive target deleted",
      blocker: /recovery_archive_workspace_topology_mismatch/,
      mutate(fixture) {
        rmSync(join(fixture.workspacePath, "openspec", "changes", "archive", "2026-07-17-change-one"), {
          recursive: true,
          force: true,
        });
      },
    },
    {
      name: "archive manifest modified",
      blocker: /recovery_archive_manifest_mismatch/,
      mutate(fixture) {
        writeFileSync(
          join(fixture.workspacePath, "openspec", "changes", "archive", "2026-07-17-change-one", "proposal.md"),
          "# Tampered proposal\n",
          "utf8",
        );
      },
    },
    {
      name: "unrelated dirty workspace",
      blocker: /recovery_archive_workspace_dirty/,
      mutate(fixture) {
        writeFileSync(join(fixture.workspacePath, "operator-note.tmp"), "uncommitted\n", "utf8");
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const fixture = eligibleRecoveryFixture();
      const dryRun = recoverManagedGoal({
        databasePath: fixture.databasePath,
        workspacePath: fixture.workspacePath,
        goalId: fixture.goalId,
      });
      const applyInput = {
        databasePath: fixture.databasePath,
        workspacePath: fixture.workspacePath,
        goalId: fixture.goalId,
        apply: true,
        planDigest: dryRun.planDigest,
        backupPath: fixture.backupPath,
        stoppedEvidencePath: fixture.stoppedEvidencePath,
      } as const;
      assert.equal(recoverManagedGoal(applyInput).applied, true, scenario.name);
      scenario.mutate(fixture);
      const databaseBeforeReplay = sha256(fixture.databasePath);

      const replay = recoverManagedGoal(applyInput);

      assert.equal(replay.eligible, false, scenario.name);
      assert.equal(replay.applied, false, scenario.name);
      assert.equal(replay.idempotent, false, scenario.name);
      assert.match(replay.blockers.join(";"), scenario.blocker, scenario.name);
      assert.equal(sha256(fixture.databasePath), databaseBeforeReplay, scenario.name);
    });
  }
});

test("operator recovery fails closed for present frozen-contract markers with invalid details", async (t) => {
  for (const marker of [
    { name: "malformed JSON", details: "{not-json" },
    { name: "valid JSON non-object", details: "[]" },
  ]) {
    await t.test(marker.name, () => {
      const fixture = eligibleRecoveryFixture();
      const db = openDatabase({ path: fixture.databasePath });
      db.prepare(`UPDATE schema_migrations SET details = ?
        WHERE name = 'managed-task-frozen-contract-repair-v1'`).run(marker.details);
      db.close();
      refreshRecoveryAuthority(fixture);
      const databaseBefore = sha256(fixture.databasePath);

      const result = recoverManagedGoal({
        databasePath: fixture.databasePath,
        workspacePath: fixture.workspacePath,
        goalId: fixture.goalId,
      });

      assert.equal(result.eligible, false);
      assert.match(result.blockers.join(";"), /ambiguous_frozen_contract:global/);
      assert.equal(sha256(fixture.databasePath), databaseBefore);
    });
  }
});

test("recovery fails closed for terminal, execution, lineage, archive, artifact, digest, and Git ambiguity", () => {
  const cases: Array<{ name: string; blocker: RegExp; mutate: (fixture: RecoveryFixture) => void }> = [
    {
      name: "wrong terminal reason",
      blocker: /wrong_terminal_reason/,
      mutate(fixture) {
        const db = openDatabase({ path: fixture.databasePath });
        db.prepare(`DELETE FROM events WHERE goal_id = ?
          AND json_extract(data, '$.runtimeEventType') = 'supervisor.continuations_exhausted'`).run(fixture.goalId);
        db.close();
      },
    },
    {
      name: "active pipeline",
      blocker: /active_run/,
      mutate(fixture) {
        const db = openDatabase({ path: fixture.databasePath });
        db.prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE goal_id = ?").run(fixture.goalId);
        db.close();
      },
    },
    {
      name: "invalid lineage",
      blocker: /invalid_lineage:parent_not_split/,
      mutate(fixture) {
        const db = openDatabase({ path: fixture.databasePath });
        const tasks = createManagedTaskRepository(db);
        tasks.registerTasks({
          goalId: fixture.goalId, changeId: "change-one",
          tasks: [{ id: "parent", title: "Parent", acceptance: [{ id: "P1", text: "One" }, { id: "P2", text: "Two" }] }],
        });
        db.prepare(`UPDATE managed_tasks SET status = 'rejected', attempt_count = 2,
          substantive_rejection_count = 2, last_cited_criteria = '["P1"]'
          WHERE goal_id = ? AND logical_task_id = 'parent'`).run(fixture.goalId);
        tasks.registerTasks({
          goalId: fixture.goalId, changeId: "change-one",
          tasks: [{ id: "child", title: "Child", parentTaskId: "parent", acceptance: [{ id: "P1", text: "One" }] }],
        });
        db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ? AND logical_task_id = 'parent'")
          .run(fixture.goalId);
        db.close();
      },
    },
    {
      name: "ambiguous migration",
      blocker: /ambiguous_migration:task-one/,
      mutate(fixture) {
        const db = openDatabase({ path: fixture.databasePath });
        db.prepare(`UPDATE schema_migrations SET details = ?
          WHERE name = 'managed-task-split-lineage-repair-v1'`)
          .run(JSON.stringify({
            mode: "initialized_repair",
            ambiguousParents: [{ taskId: `${fixture.goalId}:task-one`, reasonCodes: ["ambiguous_chronology"] }],
          }));
        db.close();
      },
    },
    {
      name: "ambiguous frozen contract migration",
      blocker: /ambiguous_frozen_contract:task-one/,
      mutate(fixture) {
        const db = openDatabase({ path: fixture.databasePath });
        assert.deepEqual(db.prepare(`
          SELECT t.status, c.outcome FROM managed_tasks t
          JOIN managed_task_criteria c ON c.task_id = t.id
          WHERE t.goal_id = ? AND t.logical_task_id = 'task-one'
        `).get(fixture.goalId), { status: "accepted", outcome: "PASS" });
        db.prepare(`UPDATE schema_migrations SET details = ?
          WHERE name = 'managed-task-frozen-contract-repair-v1'`)
          .run(JSON.stringify({
            mode: "initialized_repair",
            ambiguousTaskCount: 51,
            ambiguousTasks: Array.from({ length: 50 }, (_, index) =>
              `other-goal-${String(index + 1).padStart(3, "0")}:task-one`
            ),
            ambiguousTaskEnforcementIds: [
              ...Array.from({ length: 50 }, (_, index) =>
                `other-goal-${String(index + 1).padStart(3, "0")}:task-one`
              ),
              `${fixture.goalId}:task-one`,
            ],
          }));
        db.close();
      },
    },
    {
      name: "legacy truncated frozen contract migration",
      blocker: /ambiguous_frozen_contract:global/,
      mutate(fixture) {
        const db = openDatabase({ path: fixture.databasePath });
        db.prepare(`UPDATE schema_migrations SET details = ?
          WHERE name = 'managed-task-frozen-contract-repair-v1'`)
          .run(JSON.stringify({
            mode: "initialized_repair",
            ambiguousTaskCount: 51,
            ambiguousTasks: Array.from({ length: 50 }, (_, index) =>
              `unknown-goal-${String(index + 1).padStart(3, "0")}:unknown-task`
            ),
          }));
        db.close();
      },
    },
    {
      name: "multiple archives",
      blocker: /multiple_archive_targets/,
      mutate(fixture) {
        cpSync(
          join(fixture.workspacePath, "openspec", "changes", "archive", "2026-07-17-change-one"),
          join(fixture.workspacePath, "openspec", "changes", "archive", "2026-07-18-change-one"),
          { recursive: true },
        );
      },
    },
    {
      name: "invalid artifacts",
      blocker: /invalid_archive_artifacts:proposal_missing/,
      mutate(fixture) {
        rmSync(join(fixture.workspacePath, "openspec", "changes", "archive", "2026-07-17-change-one", "proposal.md"));
      },
    },
    {
      name: "manifest mismatch",
      blocker: /archive_manifest_digest_mismatch/,
      mutate(fixture) {
        writeFileSync(
          join(fixture.workspacePath, "openspec", "changes", "archive", "2026-07-17-change-one", "proposal.md"),
          "# Proposal changed after the delivered commit\n",
          "utf8",
        );
      },
    },
    {
      name: "incoherent Git provenance",
      blocker: /archive_commit_is_not_one_coherent_rename/,
      mutate(fixture) {
        writeFileSync(join(fixture.workspacePath, "unrelated.txt"), "smuggled side effect\n", "utf8");
        git(fixture.workspacePath, ["add", "unrelated.txt"]);
        git(fixture.workspacePath, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid",
          "commit", "--amend", "--no-edit"]);
        const amended = git(fixture.workspacePath, ["rev-parse", "HEAD"]).stdout.trim();
        const db = openDatabase({ path: fixture.databasePath });
        db.prepare("UPDATE managed_task_deliveries SET candidate_commit_sha = ?, commit_sha = ?").run(amended, amended);
        db.close();
      },
    },
  ];

  for (const scenario of cases) {
    const fixture = eligibleRecoveryFixture();
    scenario.mutate(fixture);
    refreshRecoveryAuthority(fixture);
    const databaseBefore = sha256(fixture.databasePath);
    const workspaceBefore = workspaceSnapshot(fixture.workspacePath);
    const dryRun = recoverManagedGoal({
      databasePath: fixture.databasePath, workspacePath: fixture.workspacePath, goalId: fixture.goalId,
    });
    assert.equal(dryRun.eligible, false, scenario.name);
    assert.match(dryRun.blockers.join(";"), scenario.blocker, scenario.name);

    const apply = recoverManagedGoal({
      databasePath: fixture.databasePath, workspacePath: fixture.workspacePath, goalId: fixture.goalId,
      apply: true, planDigest: dryRun.planDigest, backupPath: fixture.backupPath,
      stoppedEvidencePath: fixture.stoppedEvidencePath,
    });
    assert.equal(apply.applied, false, scenario.name);
    assert.equal(sha256(fixture.databasePath), databaseBefore, scenario.name);
    assert.equal(workspaceSnapshot(fixture.workspacePath), workspaceBefore, scenario.name);
  }
});

test("recovery apply requires exact digest, verified backup, and matching stopped-backend evidence", () => {
  for (const scenario of [
    "stale digest",
    "missing backup",
    "missing stopped evidence",
    "stale stopped database",
    "stale stopped workspace",
  ] as const) {
    const fixture = eligibleRecoveryFixture();
    if (scenario === "stale stopped database" || scenario === "stale stopped workspace") {
      writeFileSync(fixture.stoppedEvidencePath, JSON.stringify({
        backendStopped: true,
        databasePath: fixture.databasePath,
        databaseSha: scenario === "stale stopped database" ? "0".repeat(64) : sha256(fixture.databasePath),
        workspacePath: fixture.workspacePath,
        workspaceHead: scenario === "stale stopped workspace"
          ? "0".repeat(40)
          : git(fixture.workspacePath, ["rev-parse", "HEAD"]).stdout.trim(),
        goalId: fixture.goalId,
      }), "utf8");
    }
    const dryRun = recoverManagedGoal({
      databasePath: fixture.databasePath, workspacePath: fixture.workspacePath, goalId: fixture.goalId,
    });
    const databaseBefore = sha256(fixture.databasePath);
    const workspaceBefore = workspaceSnapshot(fixture.workspacePath);
    const result = recoverManagedGoal({
      databasePath: fixture.databasePath,
      workspacePath: fixture.workspacePath,
      goalId: fixture.goalId,
      apply: true,
      planDigest: scenario === "stale digest" ? "0".repeat(64) : dryRun.planDigest,
      backupPath: scenario === "missing backup" ? join(fixture.root, "missing.sqlite") : fixture.backupPath,
      stoppedEvidencePath: scenario === "missing stopped evidence"
        ? join(fixture.root, "missing-stopped.json")
        : fixture.stoppedEvidencePath,
    });
    assert.equal(result.applied, false, scenario);
    assert.match(result.blockers.join(";"),
      scenario === "stale digest" ? /stale_plan_digest/
        : scenario === "missing backup" ? /verified_backup_required/
          : scenario === "missing stopped evidence" ? /backend_stopped_evidence_required/
            : /backend_stopped_evidence_mismatch/);
    assert.equal(sha256(fixture.databasePath), databaseBefore, scenario);
    assert.equal(workspaceSnapshot(fixture.workspacePath), workspaceBefore, scenario);
  }
});

test("every recovery apply fault rolls authorization, archive event, and Goal transition back together", () => {
  for (const fault of ["after_authorization", "after_archive", "after_event", "after_goal"] as const) {
    const fixture = eligibleRecoveryFixture();
    const dryRun = recoverManagedGoal({
      databasePath: fixture.databasePath, workspacePath: fixture.workspacePath, goalId: fixture.goalId,
    });
    const before = recoveryRows(fixture);
    const workspaceBefore = workspaceSnapshot(fixture.workspacePath);
    assert.throws(() => recoverManagedGoal({
      databasePath: fixture.databasePath,
      workspacePath: fixture.workspacePath,
      goalId: fixture.goalId,
      apply: true,
      planDigest: dryRun.planDigest,
      backupPath: fixture.backupPath,
      stoppedEvidencePath: fixture.stoppedEvidencePath,
    }, {
      applyFault(point) {
        if (point === fault) throw new Error(`injected ${fault}`);
      },
    }), new RegExp(`injected ${fault}`));
    assert.deepEqual(recoveryRows(fixture), before, fault);
    assert.equal(workspaceSnapshot(fixture.workspacePath), workspaceBefore, fault);
  }
});

test("local recovery command defaults to a read-only bounded dry-run", () => {
  const fixture = eligibleRecoveryFixture();
  const before = sha256(fixture.databasePath);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "scripts/recover-managed-goal.ts",
    "--database", fixture.databasePath,
    "--workspace", fixture.workspacePath,
    "--goal", fixture.goalId,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, String(result.stderr));
  const output = JSON.parse(String(result.stdout)) as { eligible: boolean; applied: boolean; planDigest: string };
  assert.equal(output.eligible, true);
  assert.equal(output.applied, false);
  assert.match(output.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(sha256(fixture.databasePath), before);
});

test("applied recovery starts no provider and a later normal resume uses the durable continuation projection", async () => {
  const fixture = eligibleRecoveryFixture();
  const dryRun = recoverManagedGoal({
    databasePath: fixture.databasePath, workspacePath: fixture.workspacePath, goalId: fixture.goalId,
  });
  recoverManagedGoal({
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    goalId: fixture.goalId,
    apply: true,
    planDigest: dryRun.planDigest,
    backupPath: fixture.backupPath,
    stoppedEvidencePath: fixture.stoppedEvidencePath,
  });

  const db = openDatabase({ path: fixture.databasePath });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);
  assert.equal(sessions.listSessionsForGoal(fixture.goalId).length, 1, "recovery itself starts no provider session");
  let providerStarts = 0;
  let prompt = "";
  const adapter: AgentRuntimeAdapter = {
    providerId: "mock",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      providerStarts += 1;
      prompt = input.prompt;
      return {
        sessionId: input.sessionId,
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
        async *events() {},
        async send() {}, async approve() {}, async reject() {}, async cancel() {},
      };
    },
  };
  const manager = createAgentSessionManager({
    database: db, managedTaskRepo: tasks, goalRepo, runRepo, eventRepo, agentSessionRepo: sessions,
    supervisorCwd: fixture.workspacePath, maxSupervisorContinuations: 0,
  });

  await manager.resumeInterruptedGoal({
    goalId: fixture.goalId, providerId: "mock", modelLabel: "mock", adapter,
  });

  assert.equal(providerStarts, 1);
  assert.match(prompt, /Resumed after backend restart/);
  assert.match(prompt, /task-one/);
  assert.equal(sessions.listSessionsForGoal(fixture.goalId).length, 2);
  db.close();
});

test("sanitized incident-shaped source remains unchanged across separate dry-run and apply copies", () => {
  const source = eligibleRecoveryFixture();
  const sourceDatabaseHash = sha256(source.databasePath);
  const sourceWorkspace = workspaceSnapshot(source.workspacePath);
  const dryCopy = copyRecoveryFixture(source, "dry-copy");
  const applyCopy = copyRecoveryFixture(source, "apply-copy");

  const dryOne = recoverManagedGoal({
    databasePath: dryCopy.databasePath, workspacePath: dryCopy.workspacePath, goalId: dryCopy.goalId,
  });
  const dryTwo = recoverManagedGoal({
    databasePath: dryCopy.databasePath, workspacePath: dryCopy.workspacePath, goalId: dryCopy.goalId,
  });
  assert.deepEqual(dryTwo, dryOne);
  assert.equal(dryOne.eligible, true);

  const applyPlan = recoverManagedGoal({
    databasePath: applyCopy.databasePath, workspacePath: applyCopy.workspacePath, goalId: applyCopy.goalId,
  });
  const applied = recoverManagedGoal({
    databasePath: applyCopy.databasePath,
    workspacePath: applyCopy.workspacePath,
    goalId: applyCopy.goalId,
    apply: true,
    planDigest: applyPlan.planDigest,
    backupPath: applyCopy.backupPath,
    stoppedEvidencePath: applyCopy.stoppedEvidencePath,
  });
  assert.equal(applied.applied, true);
  assert.equal(sha256(source.databasePath), sourceDatabaseHash);
  assert.equal(workspaceSnapshot(source.workspacePath), sourceWorkspace);
  assert.equal(workspaceSnapshot(applyCopy.workspacePath), sourceWorkspace);
});

interface RecoveryFixture {
  root: string;
  databasePath: string;
  backupPath: string;
  stoppedEvidencePath: string;
  workspacePath: string;
  goalId: string;
  archiveCommitSha: string;
}

function eligibleRecoveryFixture(): RecoveryFixture {
  const root = mkdtempSync(join(tmpdir(), "managed-goal-recovery-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(join(workspacePath, "openspec", "changes", "change-one", "specs", "core"), { recursive: true });
  writeFileSync(join(workspacePath, "openspec", "changes", "change-one", "proposal.md"), "# Proposal\n", "utf8");
  writeFileSync(
    join(workspacePath, "openspec", "changes", "change-one", "specs", "core", "spec.md"),
    [
      "# Core", "", "## ADDED Requirements", "", "### Requirement: Recovery",
      "The system SHALL recover.", "", "#### Scenario: Proven archive",
      "- **WHEN** evidence is coherent", "- **THEN** recovery is authorized", "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspacePath, "openspec", "changes", "change-one", "tasks.md"),
    "- [x] 1.1 Implement recovery\n  - Acceptance: the archive is coherent.\n",
    "utf8",
  );
  git(workspacePath, ["init"]);
  git(workspacePath, ["add", "."]);
  git(workspacePath, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "active change"]);
  mkdirSync(join(workspacePath, "openspec", "changes", "archive"), { recursive: true });
  git(workspacePath, ["mv", "openspec/changes/change-one", "openspec/changes/archive/2026-07-17-change-one"]);
  git(workspacePath, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "provider archived change-one"]);
  const archiveCommitSha = git(workspacePath, ["rev-parse", "HEAD"]).stdout.trim();

  const databasePath = join(root, "runtime.sqlite");
  const db = openDatabase({ path: databasePath });
  const goalRepo = createGoalRepository(db);
  const goal = goalRepo.create({ title: "Recover", description: "Eligible blocked Goal" });
  goalRepo.updateStatus(goal.id, "blocked", {
    startedAt: "2026-07-17T00:00:00.000Z", completedAt: "2026-07-17T00:10:00.000Z",
  });
  const runRepo = createRunRepository(db);
  const run = runRepo.create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  runRepo.updateStatus(run.id, "completed", { finishedAt: "2026-07-17T00:10:00.000Z" });
  const sessions = createAgentSessionRepository(db);
  const session = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "codex-local", modelLabel: "gpt-5-codex",
    lifecycleState: "completed",
    capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
  });
  const tasks = createManagedTaskRepository(db);
  tasks.registerTasks({
    goalId: goal.id,
    changeId: "change-one",
    runId: run.id,
    tasks: [{ id: "task-one", title: "Delivered", acceptance: [{ id: "A1", text: "Archive delivered" }] }],
  });
  const request = sessions.createDelegationRequest({
    parentSessionId: session.id, role: "worker", taskId: "task-one", changeId: "change-one",
    promptSummary: "Deliver change-one",
  });
  tasks.beginAttempt("task-one", request.id, run.id, goal.id);
  sessions.acceptDelegationRequest(request.id);
  sessions.completeDelegationRequest(request.id, {
    kind: "success", safeSummary: "Delivered archive", criterionEvidence: [{ criterionId: "A1", evidence: "Pass" }],
    attestedFiles: ["openspec/changes/archive/2026-07-17-change-one/proposal.md"],
  });
  tasks.recordExecutorEvidence({
    goalId: goal.id, taskId: "task-one", workerDelegationRequestId: request.id,
    safeSummary: "Evidence", criterionEvidence: [{ criterionId: "A1", evidence: "Pass" }], runId: run.id,
  });
  tasks.recordReview({
    goalId: goal.id, taskId: "task-one", workerDelegationRequestId: request.id,
    judgeDelegationRequestId: null, reviewedCandidateCommitSha: archiveCommitSha, verdict: "accepted",
    decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Accepted", hasAttestedChanges: true, runId: run.id,
  });
  tasks.recordDelivery({
    goalId: goal.id, taskId: "task-one", workerDelegationRequestId: request.id,
    status: "committed", safeSummary: "Committed provider archive", checkpointHead: `${archiveCommitSha}^`,
    candidateCommitSha: archiveCommitSha, commitSha: archiveCommitSha, runId: run.id,
  });
  const events = createEventRepository(db);
  events.create({
    goalId: goal.id, runId: run.id, type: "agent.progress", message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [{ id: "change-one", title: "One", rationale: "Recover archive" }],
    },
  });
  events.create({
    goalId: goal.id, runId: run.id, type: "goal.blocked",
    message: "Supervisor reached 10 continuations without a completion signal",
    data: {
      runtimeEventType: "supervisor.continuations_exhausted",
      safeReason: "Supervisor reached 10 continuations without a completion signal",
    },
  });
  db.close();

  const backupPath = join(root, "runtime.backup.sqlite");
  cpSync(databasePath, backupPath);
  const stoppedEvidencePath = join(root, "backend-stopped.json");
  writeFileSync(stoppedEvidencePath, JSON.stringify({
    backendStopped: true,
    databasePath,
    databaseSha: sha256(databasePath),
    workspacePath,
    workspaceHead: git(workspacePath, ["rev-parse", "HEAD"]).stdout.trim(),
    goalId: goal.id,
  }), "utf8");
  return { root, databasePath, backupPath, stoppedEvidencePath, workspacePath, goalId: goal.id, archiveCommitSha };
}

function refreshRecoveryAuthority(fixture: RecoveryFixture): void {
  cpSync(fixture.databasePath, fixture.backupPath);
  writeFileSync(fixture.stoppedEvidencePath, JSON.stringify({
    backendStopped: true,
    databasePath: fixture.databasePath,
    databaseSha: sha256(fixture.databasePath),
    workspacePath: fixture.workspacePath,
    workspaceHead: git(fixture.workspacePath, ["rev-parse", "HEAD"]).stdout.trim(),
    goalId: fixture.goalId,
  }), "utf8");
}

function copyRecoveryFixture(source: RecoveryFixture, label: string): RecoveryFixture {
  const root = mkdtempSync(join(tmpdir(), `managed-goal-recovery-${label}-`));
  const databasePath = join(root, "runtime.sqlite");
  const workspacePath = join(root, "workspace");
  cpSync(source.databasePath, databasePath);
  cpSync(source.workspacePath, workspacePath, { recursive: true });
  const fixture: RecoveryFixture = {
    ...source,
    root,
    databasePath,
    workspacePath,
    backupPath: join(root, "runtime.backup.sqlite"),
    stoppedEvidencePath: join(root, "backend-stopped.json"),
  };
  refreshRecoveryAuthority(fixture);
  return fixture;
}

function workspaceSnapshot(path: string): string {
  return JSON.stringify({
    head: git(path, ["rev-parse", "HEAD"]).stdout.trim(),
    status: git(path, ["status", "--porcelain", "-uall"]).stdout,
  });
}

function recoveryRows(fixture: RecoveryFixture): unknown {
  const db = openDatabase({ path: fixture.databasePath });
  const snapshot = {
    goal: db.prepare("SELECT status, completed_at FROM goals WHERE id = ?").get(fixture.goalId),
    authorizations: db.prepare("SELECT * FROM managed_goal_recovery_authorizations WHERE goal_id = ?").all(fixture.goalId),
    archives: db.prepare("SELECT * FROM managed_change_archive_operations WHERE goal_id = ?").all(fixture.goalId),
    archivedEvents: db.prepare(`SELECT id, data FROM events WHERE goal_id = ?
      AND json_extract(data, '$.runtimeEventType') = 'change.archived'`).all(fixture.goalId),
  };
  db.close();
  return snapshot;
}

function git(cwd: string, args: string[]): { stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return { stdout: String(result.stdout) };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
