import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { AppDatabase } from "../../persistence/database.js";
import {
  computeArchiveCommitTreeManifestDigest,
  computeArchiveManifestDigest,
  proveArchiveManifestIdentity,
} from "./archive-manifest.js";
import {
  evaluateDurableManagedTaskLineage,
  loadManagedTaskMigrationAmbiguities,
} from "./managed-task-lineage.js";

const MAX_BLOCKERS = 20;

export interface ManagedGoalRecoveryInput {
  databasePath: string;
  workspacePath: string;
  goalId: string;
  apply?: boolean;
  planDigest?: string;
  backupPath?: string;
  stoppedEvidencePath?: string;
}

export interface ManagedGoalRecoveryAction {
  type: "adopt_archive" | "interrupt_goal";
  changeId?: string;
  sourcePath?: string;
  targetPath?: string;
  manifestDigest?: string;
  preArchiveHead?: string;
  archiveCommitSha?: string;
}

export interface ManagedGoalRecoveryResult {
  goalId: string;
  eligible: boolean;
  applied: boolean;
  idempotent: boolean;
  planDigest: string;
  databaseSha: string;
  blockers: string[];
  actions: ManagedGoalRecoveryAction[];
}

interface RecoveryPlanBody {
  version: 1;
  goalId: string;
  databaseSha: string;
  workspacePath: string;
  blockers: string[];
  actions: ManagedGoalRecoveryAction[];
}

interface ProvenArchive {
  changeId: string;
  sourcePath: string;
  targetPath: string;
  manifestDigest: string;
  preArchiveHead: string;
  archiveCommitSha: string;
}

export interface ManagedGoalRecoveryOptions {
  now?: () => string;
  applyFault?: (point: "after_authorization" | "after_archive" | "after_event" | "after_goal") => void;
}

/**
 * Offline, dry-run-first recovery for one explicitly selected blocked Goal.
 * Dry-run opens SQLite read-only and executes read-only Git inspection only.
 * Apply revalidates the exact plan and commits authorization, archive adoption,
 * archive event, and blocked→interrupted transition in one SQLite transaction.
 */
export function recoverManagedGoal(
  input: ManagedGoalRecoveryInput,
  options: ManagedGoalRecoveryOptions = {},
): ManagedGoalRecoveryResult {
  const databasePath = resolve(input.databasePath);
  const workspacePath = resolve(input.workspacePath);
  if (input.apply && input.planDigest) {
    const replay = readPriorAuthorization(databasePath, input.goalId, input.planDigest);
    if (replay) {
      const replayBlockers = boundedUnique([
        ...validateRecoveryReplayPostconditions(databasePath, workspacePath, input.goalId, replay),
        ...validateApplyAuthority(input, databasePath, workspacePath, replay.databaseBeforeSha),
      ]);
      if (replayBlockers.length > 0) {
        return { ...replay.result, eligible: false, applied: false, idempotent: false, blockers: replayBlockers };
      }
      return { ...replay.result, eligible: true, applied: true, idempotent: true };
    }
  }

  const plan = buildRecoveryPlan(databasePath, workspacePath, input.goalId);
  const baseResult: ManagedGoalRecoveryResult = {
    goalId: input.goalId,
    eligible: plan.body.blockers.length === 0,
    applied: false,
    idempotent: false,
    planDigest: plan.digest,
    databaseSha: plan.body.databaseSha,
    blockers: plan.body.blockers,
    actions: plan.body.actions,
  };
  if (!input.apply) return baseResult;

  const applyBlockers = [
    ...plan.body.blockers,
    ...(input.planDigest === plan.digest ? [] : ["stale_plan_digest"]),
    ...validateApplyAuthority(input, databasePath, workspacePath, plan.body.databaseSha),
  ];
  if (applyBlockers.length > 0) {
    return {
      ...baseResult,
      eligible: false,
      blockers: boundedUnique(applyBlockers),
    };
  }

  const archive = plan.archive;
  if (!archive) {
    return { ...baseResult, eligible: false, blockers: ["missing_proven_archive"] };
  }
  const backupSha = sha256File(resolve(input.backupPath!));
  const now = options.now ?? (() => new Date().toISOString());
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => {
      const goal = db.prepare("SELECT status FROM goals WHERE id = ?").get(input.goalId) as
        | { status: string }
        | undefined;
      if (goal?.status !== "blocked") throw new Error("Recovery Goal is no longer blocked.");
      const authorizationId = randomUUID();
      const archiveOperationId = randomUUID();
      const timestamp = now();
      db.prepare(`
        INSERT INTO managed_goal_recovery_authorizations (
          id, goal_id, plan_digest, plan_json, database_before_sha, backup_sha,
          workspace_path, archive_commit_sha, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        authorizationId,
        input.goalId,
        plan.digest,
        canonicalJson(baseResult),
        plan.body.databaseSha,
        backupSha,
        workspacePath,
        archive.archiveCommitSha,
        timestamp,
      );
      options.applyFault?.("after_authorization");
      db.prepare(`
        INSERT INTO managed_change_archive_operations (
          id, goal_id, change_id, source_path, target_path, manifest_digest, pre_archive_head,
          status, archive_commit_sha, diagnostics, operator_authorization_id, created_at, updated_at, finalized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?, '[]', ?, ?, ?, ?)
      `).run(
        archiveOperationId, input.goalId, archive.changeId, archive.sourcePath, archive.targetPath,
        archive.manifestDigest, archive.preArchiveHead, archive.archiveCommitSha, authorizationId,
        timestamp, timestamp, timestamp,
      );
      options.applyFault?.("after_archive");
      db.prepare(`
        INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at)
        VALUES (?, ?, NULL, NULL, 'agent.progress', ?, ?, ?)
      `).run(
        randomUUID(),
        input.goalId,
        `Operator adopted proven archive for ${archive.changeId}.`,
        JSON.stringify({
          runtimeEventType: "change.archived",
          changeId: archive.changeId,
          archiveCommitSha: archive.archiveCommitSha,
          manifestDigest: archive.manifestDigest,
          targetPath: archive.targetPath,
          operatorAuthorizationId: authorizationId,
          archiveOperationId,
          recovery: true,
        }),
        timestamp,
      );
      options.applyFault?.("after_event");
      const changed = db.prepare(`
        UPDATE goals SET status = 'interrupted', completed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'blocked'
      `).run(timestamp, input.goalId).changes;
      if (changed !== 1) throw new Error("Recovery Goal transition lost its blocked precondition.");
      options.applyFault?.("after_goal");
    })();
  } finally {
    db.close();
  }
  return { ...baseResult, eligible: true, applied: true, idempotent: false };
}

function buildRecoveryPlan(databasePath: string, workspacePath: string, goalId: string): {
  body: RecoveryPlanBody;
  digest: string;
  archive: ProvenArchive | null;
} {
  const databaseSha = sha256File(databasePath);
  const blockers: string[] = [];
  const actions: ManagedGoalRecoveryAction[] = [];
  let archive: ProvenArchive | null = null;
  let db: AppDatabase | null = null;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const goal = db.prepare("SELECT status FROM goals WHERE id = ?").get(goalId) as { status: string } | undefined;
    if (!goal) blockers.push("goal_not_found");
    else if (goal.status !== "blocked") blockers.push("goal_not_blocked");
    if (goal && !hasContinuationExhaustion(db, goalId)) blockers.push("wrong_terminal_reason");
    blockers.push(...quiescenceBlockers(db, goalId));

    const projection = goal ? evaluateDurableManagedTaskLineage(db, goalId) : null;
    for (const gap of projection?.gaps ?? []) {
      blockers.push(`invalid_lineage:${gap.reasonCode ?? "unknown"}:${(gap.taskIds ?? []).join(",")}`);
    }
    blockers.push(...migrationAmbiguityBlockers(db, goalId));
    if (goal && projection && projection.gaps.length === 0) {
      const proof = proveLegacyArchive(db, goalId, workspacePath, projection.leafTaskIds);
      blockers.push(...proof.blockers);
      archive = proof.archive;
    }
  } catch (error) {
    blockers.push(`database_or_workspace_unreadable:${safeMessage(error)}`);
  } finally {
    db?.close();
  }
  const boundedBlockers = boundedUnique(blockers);
  if (boundedBlockers.length === 0 && archive) {
    actions.push({ type: "adopt_archive", ...archive });
    actions.push({ type: "interrupt_goal" });
  }
  const body: RecoveryPlanBody = {
    version: 1,
    goalId,
    databaseSha,
    workspacePath,
    blockers: boundedBlockers,
    actions,
  };
  return { body, digest: sha256Text(canonicalJson(body)), archive };
}

function hasContinuationExhaustion(db: AppDatabase, goalId: string): boolean {
  return (db.prepare(`
    SELECT COUNT(*) FROM events
    WHERE goal_id = ?
      AND (
        json_extract(data, '$.runtimeEventType') = 'supervisor.continuations_exhausted'
        OR message = 'Supervisor reached 10 continuations without a completion signal'
      )
  `).pluck().get(goalId) as number) > 0;
}

function quiescenceBlockers(db: AppDatabase, goalId: string): string[] {
  const checks: Array<[string, string, unknown[]]> = [
    ["active_run", "SELECT COUNT(*) FROM runs WHERE goal_id = ? AND status IN ('queued', 'running')", [goalId]],
    ["active_session", `SELECT COUNT(*) FROM agent_sessions WHERE goal_id = ?
      AND lifecycle_state NOT IN ('cancelled', 'failed', 'completed', 'stalled')`, [goalId]],
    ["active_delegation", `SELECT COUNT(*) FROM agent_delegation_requests d
      JOIN agent_sessions s ON s.id = d.parent_session_id
      WHERE s.goal_id = ? AND d.status IN ('requested', 'accepted', 'running')`, [goalId]],
    ["active_task_pipeline", `SELECT COUNT(*) FROM managed_tasks
      WHERE goal_id = ? AND status IN ('delegated', 'awaiting_review', 'awaiting_delivery')`, [goalId]],
    ["pending_review", `SELECT COUNT(*) FROM managed_task_reviews r JOIN managed_tasks t ON t.id = r.task_id
      WHERE t.goal_id = ? AND r.status = 'pending'`, [goalId]],
    ["pending_delivery", `SELECT COUNT(*) FROM managed_task_deliveries d JOIN managed_tasks t ON t.id = d.task_id
      WHERE t.goal_id = ? AND d.status = 'pending'`, [goalId]],
    ["active_integration", `SELECT COUNT(*) FROM managed_task_integrations i JOIN managed_tasks t ON t.id = i.task_id
      WHERE t.goal_id = ? AND i.status IN ('pending', 'resolving', 'awaiting_review', 'accepted')`, [goalId]],
    ["active_archive_operation", `SELECT COUNT(*) FROM managed_change_archive_operations
      WHERE goal_id = ? AND status <> 'committed'`, [goalId]],
  ];
  return checks.flatMap(([code, sql, params]) =>
    (db.prepare(sql).pluck().get(...params) as number) > 0 ? [code] : []);
}

function migrationAmbiguityBlockers(db: AppDatabase, goalId: string): string[] {
  const ambiguities = loadManagedTaskMigrationAmbiguities(db, goalId);
  const blockers = ambiguities.splitLineageMarkerPresent ? [] : ["lineage_migration_missing"];
  if (ambiguities.splitLineageTaskIds.length > 0) {
    blockers.push(`ambiguous_migration:${ambiguities.splitLineageTaskIds.join(",")}`);
  }
  if (ambiguities.frozenContractTaskIds.length > 0) {
    blockers.push(`ambiguous_frozen_contract:${ambiguities.frozenContractTaskIds.join(",")}`);
  }
  if (ambiguities.frozenContractAmbiguityIsGlobal) {
    blockers.push("ambiguous_frozen_contract:global");
  }
  return blockers;
}

function proveLegacyArchive(
  db: AppDatabase,
  goalId: string,
  workspacePath: string,
  leafTaskIds: string[],
): { archive: ProvenArchive | null; blockers: string[] } {
  const blockers: string[] = [];
  const planChanges = plannedChanges(db, goalId);
  if (planChanges.length === 0) return { archive: null, blockers: ["missing_change_plan"] };
  const archived = new Set((db.prepare(`
    SELECT json_extract(data, '$.changeId') AS change_id FROM events
    WHERE goal_id = ? AND json_extract(data, '$.runtimeEventType') = 'change.archived'
  `).all(goalId) as Array<{ change_id: string | null }>).flatMap((row) => row.change_id ? [row.change_id] : []));
  const archiveRoot = resolve(workspacePath, "openspec", "changes", "archive");
  const candidates = planChanges.flatMap((changeId) => {
    if (archived.has(changeId)) return [];
    const sourcePath = resolve(workspacePath, "openspec", "changes", changeId);
    const matches = existsSync(archiveRoot)
      ? readdirSync(archiveRoot).filter((entry) => entry.endsWith(`-${changeId}`)).sort()
      : [];
    return !existsSync(sourcePath) && matches.length > 0
      ? [{ changeId, sourcePath, matches }]
      : [];
  });
  if (candidates.length !== 1) {
    return { archive: null, blockers: [candidates.length === 0 ? "missing_legacy_archive" : "multiple_legacy_archives"] };
  }
  const candidate = candidates[0]!;
  if (candidate.matches.length !== 1) return { archive: null, blockers: ["multiple_archive_targets"] };
  const targetPath = resolve(archiveRoot, candidate.matches[0]!);
  const artifactFailures = validateArchivedArtifacts(targetPath);
  if (artifactFailures.length > 0) blockers.push(`invalid_archive_artifacts:${artifactFailures.join("|")}`);
  const manifestDigest = existsSync(targetPath) ? computeArchiveManifestDigest(targetPath) : "";
  const gitProof = proveArchiveGit(workspacePath, candidate.sourcePath, targetPath);
  blockers.push(...gitProof.blockers);
  if (gitProof.treeManifestDigest && gitProof.treeManifestDigest !== manifestDigest) {
    blockers.push("archive_manifest_digest_mismatch");
  }

  const changeLeaves = new Set((db.prepare(`
    SELECT logical_task_id FROM managed_tasks WHERE goal_id = ? AND change_id = ?
  `).all(goalId, candidate.changeId) as Array<{ logical_task_id: string }>).map((row) => row.logical_task_id));
  const requiredLeaves = leafTaskIds.filter((taskId) => changeLeaves.has(taskId));
  if (requiredLeaves.length === 0) blockers.push("archive_change_has_no_leaf_tasks");
  const placeholders = requiredLeaves.map(() => "?").join(",");
  if (requiredLeaves.length > 0) {
    const notAccepted = db.prepare(`
      SELECT logical_task_id FROM managed_tasks
      WHERE goal_id = ? AND logical_task_id IN (${placeholders}) AND status <> 'accepted'
    `).all(goalId, ...requiredLeaves) as Array<{ logical_task_id: string }>;
    if (notAccepted.length > 0) blockers.push(`undelivered_leaf:${notAccepted.map((row) => row.logical_task_id).join(",")}`);
  }
  if (gitProof.archiveCommitSha) {
    const deliveredCommits = db.prepare(`
      SELECT d.commit_sha FROM managed_task_deliveries d
      JOIN managed_tasks t ON t.id = d.task_id
      WHERE t.goal_id = ? AND t.change_id = ? AND d.status = 'committed'
    `).all(goalId, candidate.changeId) as Array<{ commit_sha: string | null }>;
    if (!deliveredCommits.some((row) => row.commit_sha === gitProof.archiveCommitSha)) {
      blockers.push("archive_commit_not_in_delivered_evidence");
    }
  }
  const existingOperation = db.prepare(`
    SELECT status FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = ?
  `).get(goalId, candidate.changeId) as { status: string } | undefined;
  if (existingOperation) blockers.push("archive_operation_already_exists");

  return {
    archive: blockers.length === 0 && gitProof.archiveCommitSha && gitProof.preArchiveHead
      ? {
          changeId: candidate.changeId,
          sourcePath: candidate.sourcePath,
          targetPath,
          manifestDigest,
          preArchiveHead: gitProof.preArchiveHead,
          archiveCommitSha: gitProof.archiveCommitSha,
        }
      : null,
    blockers,
  };
}

function plannedChanges(db: AppDatabase, goalId: string): string[] {
  const rows = db.prepare(`
    SELECT data FROM events WHERE goal_id = ?
      AND json_extract(data, '$.runtimeEventType') = 'supervisor.change_plan'
    ORDER BY created_at, rowid
  `).all(goalId) as Array<{ data: string }>;
  const ids: string[] = [];
  for (const row of rows) {
    const data = parseObject(row.data);
    const changes = Array.isArray(data.changePlan) ? data.changePlan : [];
    for (const value of changes) {
      if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && !ids.includes(value.id)) {
        ids.push(value.id);
      }
    }
  }
  return ids;
}

function proveArchiveGit(workspacePath: string, sourcePath: string, targetPath: string): {
  archiveCommitSha: string | null;
  preArchiveHead: string | null;
  treeManifestDigest: string | null;
  blockers: string[];
} {
  const source = relative(workspacePath, sourcePath).replace(/\\/g, "/");
  const target = relative(workspacePath, targetPath).replace(/\\/g, "/");
  const status = git(workspacePath, ["status", "--porcelain", "-uall"]);
  const blockers = !status.ok || status.stdout.trim() ? ["workspace_not_clean"] : [];
  const trackedTarget = git(workspacePath, ["cat-file", "-e", `HEAD:${target}`]);
  const trackedSource = git(workspacePath, ["cat-file", "-e", `HEAD:${source}`]);
  if (!trackedTarget.ok || trackedSource.ok) {
    return { archiveCommitSha: null, preArchiveHead: null, treeManifestDigest: null,
      blockers: [...blockers, "archive_head_topology_mismatch"] };
  }
  const log = git(workspacePath, ["log", "--format=%H", "--", target]);
  const commits = log.ok ? log.stdout.trim().split(/\s+/).filter(Boolean) : [];
  if (commits.length !== 1) return { archiveCommitSha: null, preArchiveHead: null, treeManifestDigest: null,
    blockers: [...blockers, "incoherent_archive_git_history"] };
  const archiveCommitSha = commits[0]!;
  const show = git(workspacePath, ["show", "--format=", "--name-status", "--find-renames=50%", archiveCommitSha]);
  const lines = show.stdout.replace(/\\/g, "/").trim().split(/\r?\n/).filter(Boolean);
  const coherentRename = lines.length > 0 && lines.every((line) => {
    const [statusCode, from, to] = line.split("\t");
    if (!/^R\d+$/.test(statusCode ?? "") || !from || !to) return false;
    if (!from.startsWith(`${source}/`) || !to.startsWith(`${target}/`)) return false;
    return from.slice(source.length) === to.slice(target.length);
  });
  if (!show.ok || !coherentRename) {
    return { archiveCommitSha: null, preArchiveHead: null, treeManifestDigest: null,
      blockers: [...blockers, "archive_commit_is_not_one_coherent_rename"] };
  }
  const ancestor = git(workspacePath, ["merge-base", "--is-ancestor", archiveCommitSha, "HEAD"]);
  const parent = git(workspacePath, ["rev-parse", `${archiveCommitSha}^`]);
  if (!ancestor.ok || !parent.ok || !parent.stdout.trim()) {
    return { archiveCommitSha: null, preArchiveHead: null, treeManifestDigest: null,
      blockers: [...blockers, "archive_commit_provenance_mismatch"] };
  }
  return {
    archiveCommitSha,
    preArchiveHead: parent.stdout.trim(),
    treeManifestDigest: computeArchiveCommitTreeManifestDigest(workspacePath, archiveCommitSha, target),
    blockers,
  };
}

function validateArchivedArtifacts(changeDir: string): string[] {
  const failures: string[] = [];
  if (!existsSync(join(changeDir, "proposal.md"))) failures.push("proposal_missing");
  const specDir = join(changeDir, "specs");
  const specs = existsSync(specDir) ? listFiles(specDir).filter((path) => path.endsWith(".md")) : [];
  if (specs.length === 0) failures.push("specs_missing");
  for (const path of specs) {
    const content = readFileSync(path, "utf8");
    if (!/^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements/m.test(content)) failures.push("delta_header_missing");
    const requirements = content.split(/^### Requirement:/m).slice(1);
    if (requirements.length === 0 || requirements.some((requirement) =>
      !/^#### Scenario:/m.test(requirement) || !/\*\*WHEN\*\*/.test(requirement) || !/\*\*THEN\*\*/.test(requirement))) {
      failures.push("scenario_invalid");
    }
  }
  const tasksPath = join(changeDir, "tasks.md");
  if (!existsSync(tasksPath)) failures.push("tasks_missing");
  else {
    const lines = readFileSync(tasksPath, "utf8").split(/\r?\n/);
    const taskIndexes = lines.flatMap((line, index) => (/^\s*- \[[ x]\]/.test(line) ? [index] : []));
    if (taskIndexes.length === 0) failures.push("tasks_empty");
    for (const index of taskIndexes) {
      const next = taskIndexes.find((candidate) => candidate > index) ?? lines.length;
      if (!/Acceptance:/i.test(lines.slice(index, next).join("\n"))) failures.push("task_acceptance_missing");
    }
  }
  return boundedUnique(failures);
}

function validateApplyAuthority(
  input: ManagedGoalRecoveryInput,
  databasePath: string,
  workspacePath: string,
  expectedDatabaseSha: string,
): string[] {
  const blockers: string[] = [];
  if (!input.backupPath || !existsSync(resolve(input.backupPath))) blockers.push("verified_backup_required");
  else {
    const backupPath = resolve(input.backupPath);
    if (backupPath === databasePath || sha256File(backupPath) !== expectedDatabaseSha || !sqliteQuickCheck(backupPath)) {
      blockers.push("backup_verification_failed");
    }
  }
  if (!input.stoppedEvidencePath || !existsSync(resolve(input.stoppedEvidencePath))) {
    blockers.push("backend_stopped_evidence_required");
  } else {
    const evidence = parseObject(readFileSync(resolve(input.stoppedEvidencePath), "utf8"));
    const workspaceHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      encoding: "utf8",
      windowsHide: true,
    });
    if (
      evidence.backendStopped !== true
      || resolve(String(evidence.databasePath ?? "")) !== databasePath
      || evidence.databaseSha !== expectedDatabaseSha
      || resolve(String(evidence.workspacePath ?? "")) !== workspacePath
      || workspaceHead.status !== 0
      || evidence.workspaceHead !== String(workspaceHead.stdout ?? "").trim()
      || evidence.goalId !== input.goalId
    ) {
      blockers.push("backend_stopped_evidence_mismatch");
    }
  }
  return blockers;
}

function readPriorAuthorization(
  databasePath: string,
  goalId: string,
  planDigest: string,
): PriorRecoveryAuthorization | null {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare(`
      SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'managed_goal_recovery_authorizations'
    `).pluck().get() as number;
    if (!table) return null;
    const row = db.prepare(`
      SELECT id, database_before_sha, archive_commit_sha, plan_json FROM managed_goal_recovery_authorizations
      WHERE goal_id = ? AND plan_digest = ?
    `).get(goalId, planDigest) as {
      id: string;
      database_before_sha: string;
      archive_commit_sha: string;
      plan_json: string;
    } | undefined;
    if (!row) return null;
    return {
      authorizationId: row.id,
      databaseBeforeSha: row.database_before_sha,
      archiveCommitSha: row.archive_commit_sha,
      result: JSON.parse(row.plan_json) as ManagedGoalRecoveryResult,
    };
  } finally {
    db.close();
  }
}

interface PriorRecoveryAuthorization {
  authorizationId: string;
  databaseBeforeSha: string;
  archiveCommitSha: string;
  result: ManagedGoalRecoveryResult;
}

function validateRecoveryReplayPostconditions(
  databasePath: string,
  workspacePath: string,
  goalId: string,
  replay: PriorRecoveryAuthorization,
): string[] {
  const blockers: string[] = [];
  const archiveActions = replay.result.actions.filter((action) => action.type === "adopt_archive");
  const interruptActions = replay.result.actions.filter((action) => action.type === "interrupt_goal");
  if (archiveActions.length !== 1 || interruptActions.length !== 1) {
    return ["recovery_authorization_plan_mismatch"];
  }
  const action = archiveActions[0]!;
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const goal = db.prepare("SELECT status, completed_at FROM goals WHERE id = ?")
      .get(goalId) as { status: string; completed_at: string | null } | undefined;
    if (!goal || goal.status !== "interrupted" || goal.completed_at !== null) {
      blockers.push("recovery_goal_postcondition_mismatch");
    }

    const operations = db.prepare(`
      SELECT id, goal_id, change_id, source_path, target_path, manifest_digest, pre_archive_head,
        status, archive_commit_sha, operator_authorization_id
      FROM managed_change_archive_operations WHERE operator_authorization_id = ?
    `).all(replay.authorizationId) as Array<Record<string, string | null>>;
    if (operations.length !== 1) {
      blockers.push("recovery_archive_operation_count_mismatch");
    }
    const operation = operations[0];
    if (operation) {
      const matchingOperations = db.prepare(`
        SELECT COUNT(*) FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = ?
      `).pluck().get(goalId, action.changeId) as number;
      if (matchingOperations !== 1) blockers.push("recovery_archive_operation_count_mismatch");
      if (
        operation.goal_id !== goalId
        || operation.change_id !== action.changeId
        || operation.source_path !== action.sourcePath
        || operation.target_path !== action.targetPath
        || operation.manifest_digest !== action.manifestDigest
        || operation.pre_archive_head !== action.preArchiveHead
        || operation.status !== "committed"
        || operation.archive_commit_sha !== replay.archiveCommitSha
        || operation.archive_commit_sha !== action.archiveCommitSha
        || operation.operator_authorization_id !== replay.authorizationId
      ) {
        blockers.push("recovery_archive_postcondition_mismatch");
      }
    }

    const events = db.prepare(`
      SELECT data FROM events WHERE goal_id = ?
        AND json_extract(data, '$.runtimeEventType') = 'change.archived'
        AND json_extract(data, '$.changeId') = ?
    `).all(goalId, action.changeId) as Array<{ data: string }>;
    if (events.length !== 1) {
      blockers.push("recovery_archive_event_count_mismatch");
    } else if (operation) {
      const data = parseObject(events[0]!.data);
      if (
        data.operatorAuthorizationId !== replay.authorizationId
        || data.archiveOperationId !== operation.id
        || data.archiveCommitSha !== replay.archiveCommitSha
        || data.manifestDigest !== action.manifestDigest
        || data.targetPath !== action.targetPath
        || data.recovery !== true
      ) {
        blockers.push("recovery_archive_event_postcondition_mismatch");
      }
    }
  } catch (error) {
    blockers.push(`recovery_postcondition_unreadable:${safeMessage(error)}`);
  } finally {
    db.close();
  }
  blockers.push(...validateRecoveryReplayWorkspace(workspacePath, action, replay));
  return boundedUnique(blockers);
}

function validateRecoveryReplayWorkspace(
  workspacePath: string,
  action: ManagedGoalRecoveryAction,
  replay: PriorRecoveryAuthorization,
): string[] {
  if (
    !action.changeId
    || !action.sourcePath
    || !action.targetPath
    || !action.manifestDigest
    || !action.preArchiveHead
    || !action.archiveCommitSha
  ) {
    return ["recovery_authorization_plan_mismatch"];
  }

  const blockers: string[] = [];
  const sourcePath = resolve(action.sourcePath);
  const targetPath = resolve(action.targetPath);
  const expectedSourcePath = resolve(workspacePath, "openspec", "changes", action.changeId);
  const archiveRoot = resolve(workspacePath, "openspec", "changes", "archive");
  const targetRelative = relative(archiveRoot, targetPath).replace(/\\/g, "/");
  let matchingTargets: string[] = [];
  try {
    matchingTargets = existsSync(archiveRoot)
      ? readdirSync(archiveRoot).filter((entry) => entry.endsWith(`-${action.changeId}`)).sort()
      : [];
  } catch {
    blockers.push("recovery_archive_workspace_topology_mismatch");
  }
  const targetIdentityValid = sourcePath === expectedSourcePath
    && targetRelative.length > 0
    && !targetRelative.startsWith("../")
    && !targetRelative.includes("/")
    && targetRelative.endsWith(`-${action.changeId}`)
    && matchingTargets.length === 1
    && resolve(archiveRoot, matchingTargets[0]!) === targetPath;
  if (!targetIdentityValid || existsSync(sourcePath) || !existsSync(targetPath)) {
    blockers.push("recovery_archive_workspace_topology_mismatch");
  }

  const status = git(workspacePath, ["status", "--porcelain", "-uall"]);
  if (!status.ok || status.stdout.trim()) blockers.push("recovery_archive_workspace_dirty");

  if (existsSync(targetPath)) {
    try {
      if (!statSync(targetPath).isDirectory() || computeArchiveManifestDigest(targetPath) !== action.manifestDigest) {
        blockers.push("recovery_archive_manifest_mismatch");
      }
    } catch {
      blockers.push("recovery_archive_manifest_mismatch");
    }
  }

  const proof = proveArchiveGit(workspacePath, sourcePath, targetPath);
  const proofBlockers = proof.blockers.filter((blocker) => blocker !== "workspace_not_clean");
  const manifestProof = proof.archiveCommitSha
    ? proveArchiveManifestIdentity({
        cwd: workspacePath,
        targetPath,
        targetRelative: relative(workspacePath, targetPath).replace(/\\/g, "/"),
        archiveCommitSha: proof.archiveCommitSha,
        expectedDigest: action.manifestDigest,
      })
    : null;
  if (
    proofBlockers.length > 0
    || proof.archiveCommitSha !== action.archiveCommitSha
    || proof.archiveCommitSha !== replay.archiveCommitSha
    || proof.preArchiveHead !== action.preArchiveHead
    || !manifestProof?.ok
  ) {
    blockers.push("recovery_archive_commit_proof_mismatch");
  }

  return boundedUnique(blockers);
}

function sqliteQuickCheck(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return db.pragma("quick_check", { simple: true }) === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, stdout: String(result.stdout ?? "") };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function boundedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))]
    .sort().map((value) => value.slice(0, 500)).slice(0, MAX_BLOCKERS);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}
