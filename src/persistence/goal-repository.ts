import { randomUUID } from "node:crypto";

import type { CreateGoalInput, Goal, GoalStatus } from "../domain/index.js";
import type { AppDatabase } from "./database.js";

export interface GoalRepository {
  create(input: CreateGoalInput): Goal;
  list(): Goal[];
  listByStatus(status: GoalStatus): Goal[];
  getById(id: string): Goal | null;
  updateStatus(id: string, status: GoalStatus, timestamps?: GoalStatusTimestamps): Goal;
}

export interface GoalStatusTimestamps {
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface GoalRepositoryOptions {
  /** Clock for created/updated timestamps. Injectable for deterministic tests. */
  now?: () => string;
}

export function createGoalRepository(
  db: AppDatabase,
  options: GoalRepositoryOptions = {},
): GoalRepository {
  const clock = options.now ?? (() => new Date().toISOString());

  return {
    create(input) {
      const now = clock();
      const goal: Goal = {
        id: randomUUID(),
        title: input.title,
        description: input.description,
        status: "draft",
        priority: input.priority ?? "normal",
        agentType: input.agentType ?? "general",
        confirmationPolicy: input.confirmationPolicy ?? "off",
        workspace: input.workspace ?? null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      };

      db.prepare(`
        INSERT INTO goals (
          id,
          title,
          description,
          status,
          priority,
          agent_type,
          confirmation_policy,
          workspace,
          created_at,
          updated_at,
          started_at,
          completed_at
        )
        VALUES (
          @id,
          @title,
          @description,
          @status,
          @priority,
          @agentType,
          @confirmationPolicy,
          @workspace,
          @createdAt,
          @updatedAt,
          @startedAt,
          @completedAt
        )
      `).run(goal);

      return goal;
    },

    list() {
      return db
        .prepare("SELECT * FROM goals ORDER BY created_at DESC, id DESC")
        .all()
        .map(mapGoalRow);
    },

    listByStatus(status) {
      return db
        .prepare("SELECT * FROM goals WHERE status = ? ORDER BY created_at ASC, id ASC")
        .all(status)
        .map(mapGoalRow);
    },

    getById(id) {
      const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
      return row ? mapGoalRow(row) : null;
    },

    updateStatus(id, status, timestamps = {}) {
      const existing = this.getById(id);
      if (!existing) {
        throw new Error(`Goal not found: ${id}`);
      }

      const updatedAt = clock();
      const startedAt = timestamps.startedAt === undefined ? existing.startedAt : timestamps.startedAt;
      const completedAt = timestamps.completedAt === undefined ? existing.completedAt : timestamps.completedAt;

      db.prepare(`
        UPDATE goals
        SET status = ?, updated_at = ?, started_at = ?, completed_at = ?
        WHERE id = ?
      `).run(status, updatedAt, startedAt, completedAt, id);

      return this.getById(id)!;
    },
  };
}

function mapGoalRow(row: unknown): Goal {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    title: value.title!,
    description: value.description!,
    status: value.status as Goal["status"],
    priority: value.priority as Goal["priority"],
    agentType: value.agent_type as Goal["agentType"],
    // Default off for rows created before the column existed.
    confirmationPolicy: (value.confirmation_policy as Goal["confirmationPolicy"]) ?? "off",
    // Null resolves to the server default workspace at run time.
    workspace: value.workspace ?? null,
    createdAt: value.created_at!,
    updatedAt: value.updated_at!,
    startedAt: value.started_at,
    completedAt: value.completed_at,
  };
}
