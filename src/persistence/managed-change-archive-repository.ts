import { randomUUID } from "node:crypto";

import type { AppDatabase } from "./database.js";

export type ManagedChangeArchiveStatus = "pending" | "committed" | "blocked";

export interface ManagedChangeArchiveOperation {
  id: string;
  goalId: string;
  changeId: string;
  sourcePath: string;
  targetPath: string;
  manifestDigest: string;
  preArchiveHead: string;
  status: ManagedChangeArchiveStatus;
  archiveCommitSha: string | null;
  diagnostics: string[];
  operatorAuthorizationId: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}

export interface BeginManagedChangeArchiveIntent {
  goalId: string;
  changeId: string;
  sourcePath: string;
  targetPath: string;
  manifestDigest: string;
  preArchiveHead: string;
  operatorAuthorizationId?: string | null;
}

export interface ManagedChangeArchiveRepositoryOptions {
  now?: () => string;
  fault?: (point: "before_final_event" | "after_final_event") => void;
}

export interface ManagedChangeArchiveRepository {
  beginIntent(input: BeginManagedChangeArchiveIntent): ManagedChangeArchiveOperation;
  get(goalId: string, changeId: string): ManagedChangeArchiveOperation | null;
  listForGoal(goalId: string): ManagedChangeArchiveOperation[];
  listPending(): ManagedChangeArchiveOperation[];
  markBlocked(goalId: string, changeId: string, diagnostics: string[]): ManagedChangeArchiveOperation;
  finalize(input: {
    goalId: string;
    changeId: string;
    archiveCommitSha: string;
    runId: string | null;
    safeSummary: string;
  }): ManagedChangeArchiveOperation;
}

export function createManagedChangeArchiveRepository(
  db: AppDatabase,
  options: ManagedChangeArchiveRepositoryOptions = {},
): ManagedChangeArchiveRepository {
  const now = options.now ?? (() => new Date().toISOString());
  const get = (goalId: string, changeId: string) => {
    const row = db.prepare(`
      SELECT * FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = ?
    `).get(goalId, changeId);
    return row ? mapArchiveOperation(row) : null;
  };

  return {
    beginIntent(input) {
      const existing = get(input.goalId, input.changeId);
      if (existing) {
        if (
          existing.sourcePath !== input.sourcePath || existing.targetPath !== input.targetPath
          || existing.manifestDigest !== input.manifestDigest || existing.preArchiveHead !== input.preArchiveHead
        ) {
          throw new Error(`Archive identity mismatch is ambiguous for change ${input.changeId}.`);
        }
        return existing;
      }
      const timestamp = now();
      db.prepare(`
        INSERT INTO managed_change_archive_operations (
          id, goal_id, change_id, source_path, target_path, manifest_digest, pre_archive_head,
          status, archive_commit_sha, diagnostics, operator_authorization_id, created_at, updated_at, finalized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, '[]', ?, ?, ?, NULL)
      `).run(
        randomUUID(), input.goalId, input.changeId, input.sourcePath, input.targetPath,
        input.manifestDigest, input.preArchiveHead, input.operatorAuthorizationId ?? null,
        timestamp, timestamp,
      );
      return get(input.goalId, input.changeId)!;
    },
    get,
    listForGoal(goalId) {
      return db.prepare(`
        SELECT * FROM managed_change_archive_operations WHERE goal_id = ? ORDER BY created_at, rowid
      `).all(goalId).map(mapArchiveOperation);
    },
    listPending() {
      return db.prepare(`
        SELECT * FROM managed_change_archive_operations WHERE status <> 'committed' ORDER BY created_at, rowid
      `).all().map(mapArchiveOperation);
    },
    markBlocked(goalId, changeId, diagnostics) {
      const operation = get(goalId, changeId);
      if (!operation) throw new Error(`Managed archive operation not found: ${goalId}:${changeId}`);
      if (operation.status === "committed") return operation;
      db.prepare(`
        UPDATE managed_change_archive_operations
        SET status = 'blocked', diagnostics = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(boundedDiagnostics(diagnostics)), now(), operation.id);
      return get(goalId, changeId)!;
    },
    finalize(input) {
      return db.transaction(() => {
        const operation = get(input.goalId, input.changeId);
        if (!operation) throw new Error(`Managed archive operation not found: ${input.goalId}:${input.changeId}`);
        if (operation.status === "committed") {
          if (operation.archiveCommitSha !== input.archiveCommitSha) {
            throw new Error(`Committed archive SHA mismatch for change ${input.changeId}.`);
          }
          return operation;
        }
        const timestamp = now();
        db.prepare(`
          UPDATE managed_change_archive_operations
          SET status = 'committed', archive_commit_sha = ?, diagnostics = '[]', updated_at = ?, finalized_at = ?
          WHERE id = ?
        `).run(input.archiveCommitSha, timestamp, timestamp, operation.id);
        options.fault?.("before_final_event");
        db.prepare(`
          INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at)
          VALUES (?, ?, ?, NULL, 'agent.progress', ?, ?, ?)
        `).run(
          randomUUID(), input.goalId, input.runId, input.safeSummary,
          JSON.stringify({
            runtimeEventType: "change.archived",
            changeId: input.changeId,
            archiveOperationId: operation.id,
            targetPath: operation.targetPath,
            manifestDigest: operation.manifestDigest,
            archiveCommitSha: input.archiveCommitSha,
          }),
          timestamp,
        );
        options.fault?.("after_final_event");
        return get(input.goalId, input.changeId)!;
      })();
    },
  };
}

function mapArchiveOperation(row: unknown): ManagedChangeArchiveOperation {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    goalId: value.goal_id!,
    changeId: value.change_id!,
    sourcePath: value.source_path!,
    targetPath: value.target_path!,
    manifestDigest: value.manifest_digest!,
    preArchiveHead: value.pre_archive_head!,
    status: value.status as ManagedChangeArchiveStatus,
    archiveCommitSha: value.archive_commit_sha,
    diagnostics: JSON.parse(value.diagnostics ?? "[]") as string[],
    operatorAuthorizationId: value.operator_authorization_id,
    createdAt: value.created_at!,
    updatedAt: value.updated_at!,
    finalizedAt: value.finalized_at,
  };
}

function boundedDiagnostics(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))]
    .map((value) => value.slice(0, 500))
    .slice(0, 20);
}
