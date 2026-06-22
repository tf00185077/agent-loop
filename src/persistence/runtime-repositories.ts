import { randomUUID } from "node:crypto";

import type {
  CreateEventInput,
  CreateRunInput,
  CreateStepInput,
  Event,
  Run,
  RunStatus,
  Step,
  StepStatus,
  UpdateStepInput,
} from "../domain/index.js";
import type { AppDatabase } from "./database.js";
import type { EventBus } from "./event-bus.js";

export interface RunRepository {
  create(input: CreateRunInput): Run;
  updateStatus(id: string, status: RunStatus, options?: { finishedAt?: string | null; error?: string | null }): Run;
  getById(id: string): Run | null;
}

export interface StepRepository {
  create(input: CreateStepInput): Step;
  update(id: string, input: UpdateStepInput): Step;
  listForRun(runId: string): Step[];
}

export interface EventRepository {
  create(input: CreateEventInput): Event;
  listForGoal(goalId: string): Event[];
}

export function createRunRepository(db: AppDatabase): RunRepository {
  return {
    create(input) {
      const run: Run = {
        id: randomUUID(),
        goalId: input.goalId,
        status: "running",
        provider: input.provider,
        model: input.model,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
      };

      db.prepare(`
        INSERT INTO runs (id, goal_id, status, provider, model, started_at, finished_at, error)
        VALUES (@id, @goalId, @status, @provider, @model, @startedAt, @finishedAt, @error)
      `).run(run);

      return run;
    },

    updateStatus(id, status, options = {}) {
      const existing = this.getById(id);
      if (!existing) {
        throw new Error(`Run not found: ${id}`);
      }

      const finishedAt = options.finishedAt === undefined ? existing.finishedAt : options.finishedAt;
      const error = options.error === undefined ? existing.error : options.error;
      db.prepare("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(status, finishedAt, error, id);

      return this.getById(id)!;
    },

    getById(id) {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
      return row ? mapRunRow(row) : null;
    },
  };
}

export function createStepRepository(db: AppDatabase): StepRepository {
  return {
    create(input) {
      const now = new Date().toISOString();
      const step: Step = {
        id: randomUUID(),
        goalId: input.goalId,
        runId: input.runId,
        title: input.title,
        description: input.description,
        status: "pending",
        order: input.order,
        result: null,
        createdAt: now,
        updatedAt: now,
      };

      db.prepare(`
        INSERT INTO steps (id, goal_id, run_id, title, description, status, step_order, result, created_at, updated_at)
        VALUES (@id, @goalId, @runId, @title, @description, @status, @order, @result, @createdAt, @updatedAt)
      `).run(step);

      return step;
    },

    update(id, input) {
      const existing = getStepById(db, id);
      if (!existing) {
        throw new Error(`Step not found: ${id}`);
      }

      db.prepare(`
        UPDATE steps
        SET title = ?, description = ?, status = ?, result = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.title ?? existing.title,
        input.description ?? existing.description,
        input.status ?? existing.status,
        input.result === undefined ? existing.result : input.result,
        new Date().toISOString(),
        id,
      );

      return getStepById(db, id)!;
    },

    listForRun(runId) {
      return db
        .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_order ASC, created_at ASC")
        .all(runId)
        .map(mapStepRow);
    },
  };
}

export interface EventRepositoryOptions {
  /** Notified with the persisted event after each insert, for live streaming. */
  eventBus?: EventBus;
}

export function createEventRepository(
  db: AppDatabase,
  options: EventRepositoryOptions = {},
): EventRepository {
  return {
    create(input) {
      const event: Event = {
        id: randomUUID(),
        goalId: input.goalId,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        type: input.type,
        message: input.message,
        data: input.data ?? {},
        createdAt: new Date().toISOString(),
      };

      db.prepare(`
        INSERT INTO events (id, goal_id, run_id, step_id, type, message, data, created_at)
        VALUES (@id, @goalId, @runId, @stepId, @type, @message, @data, @createdAt)
      `).run({ ...event, data: JSON.stringify(event.data) });

      options.eventBus?.publish(event);

      return event;
    },

    listForGoal(goalId) {
      // Order by creation time, falling back to insertion order (rowid) so
      // events written within the same millisecond stay in creation order.
      return db
        .prepare("SELECT * FROM events WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(goalId)
        .map(mapEventRow);
    },
  };
}

function getStepById(db: AppDatabase, id: string): Step | null {
  const row = db.prepare("SELECT * FROM steps WHERE id = ?").get(id);
  return row ? mapStepRow(row) : null;
}

function mapRunRow(row: unknown): Run {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    goalId: value.goal_id!,
    status: value.status as RunStatus,
    provider: value.provider!,
    model: value.model!,
    startedAt: value.started_at!,
    finishedAt: value.finished_at,
    error: value.error,
  };
}

function mapStepRow(row: unknown): Step {
  const value = row as Record<string, string | number | null>;
  return {
    id: value.id as string,
    goalId: value.goal_id as string,
    runId: value.run_id as string,
    title: value.title as string,
    description: value.description as string,
    status: value.status as StepStatus,
    order: value.step_order as number,
    result: value.result as string | null,
    createdAt: value.created_at as string,
    updatedAt: value.updated_at as string,
  };
}

function mapEventRow(row: unknown): Event {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    goalId: value.goal_id!,
    runId: value.run_id,
    stepId: value.step_id,
    type: value.type as Event["type"],
    message: value.message!,
    data: JSON.parse(value.data ?? "{}") as Event["data"],
    createdAt: value.created_at!,
  };
}
