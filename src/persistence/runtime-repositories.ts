import { randomUUID } from "node:crypto";

import type {
  AgentRuntimeApprovalRequest,
  AgentRuntimeApprovalStatus,
  AgentRuntimeCapabilities,
  AgentRuntimeChildSessionRequest,
  AgentRuntimeChildSessionRequestStatus,
  AgentRuntimeCommandDiagnostics,
  AgentRuntimeCommandRecord,
  AgentRuntimeCommandStatus,
  AgentRuntimeSession,
  AgentRuntimeSessionParent,
  AgentSessionLifecycleState,
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
  updateMetadata(id: string, metadata: { provider: string; model: string }): Run;
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

export interface CreateAgentRuntimeSessionInput {
  goalId: string;
  runId: string;
  providerId: string;
  modelLabel: string | null;
  lifecycleState: AgentSessionLifecycleState;
  capabilities: AgentRuntimeCapabilities;
  parent?: AgentRuntimeSessionParent | null;
}

export type CreateAgentRuntimeCommandInput = Omit<AgentRuntimeCommandRecord, "id">;

export interface CreateAgentRuntimeApprovalInput {
  sessionId: string;
  commandId?: string | null;
  safeSummary: string;
}

export interface CreateAgentRuntimeChildSessionRequestInput {
  parentSessionId: string;
  parentAgentId?: string | null;
  childRole: string;
  taskId?: string | null;
  promptSummary: string;
  status?: AgentRuntimeChildSessionRequestStatus;
  resolvedAt?: string | null;
  safeReason?: string | null;
}

export interface AgentSessionRepositoryOptions {
  now?: () => string;
}

export interface AgentSessionRepository {
  createSession(input: CreateAgentRuntimeSessionInput): AgentRuntimeSession;
  updateLifecycleState(id: string, state: AgentSessionLifecycleState): AgentRuntimeSession;
  getSession(id: string): AgentRuntimeSession | null;
  listSessionsForGoal(goalId: string): AgentRuntimeSession[];
  recordCommand(input: CreateAgentRuntimeCommandInput): AgentRuntimeCommandRecord;
  createApprovalRequest(input: CreateAgentRuntimeApprovalInput): AgentRuntimeApprovalRequest;
  resolveApprovalRequest(
    id: string,
    status: Extract<AgentRuntimeApprovalStatus, "approved" | "rejected" | "cancelled">,
    reason?: string | null,
  ): AgentRuntimeApprovalRequest;
  listApprovalRequests(sessionId: string): AgentRuntimeApprovalRequest[];
  recordChildSessionRequest(input: CreateAgentRuntimeChildSessionRequestInput): AgentRuntimeChildSessionRequest;
  listChildSessionRequests(parentSessionId: string): AgentRuntimeChildSessionRequest[];
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

    updateMetadata(id, metadata) {
      const existing = this.getById(id);
      if (!existing) {
        throw new Error(`Run not found: ${id}`);
      }

      db.prepare("UPDATE runs SET provider = ?, model = ? WHERE id = ?").run(metadata.provider, metadata.model, id);

      return this.getById(id)!;
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

export function createAgentSessionRepository(
  db: AppDatabase,
  options: AgentSessionRepositoryOptions = {},
): AgentSessionRepository {
  const clock = options.now ?? (() => new Date().toISOString());

  function touchSession(sessionId: string): void {
    db.prepare("UPDATE agent_sessions SET last_activity_at = ? WHERE id = ?").run(clock(), sessionId);
  }

  return {
    createSession(input) {
      const now = clock();
      const session: AgentRuntimeSession = {
        id: randomUUID(),
        goalId: input.goalId,
        runId: input.runId,
        providerId: input.providerId,
        modelLabel: input.modelLabel,
        lifecycleState: input.lifecycleState,
        capabilities: input.capabilities,
        parent: input.parent ?? null,
        createdAt: now,
        lastActivityAt: now,
      };

      db.prepare(`
        INSERT INTO agent_sessions (
          id,
          goal_id,
          run_id,
          provider_id,
          model_label,
          lifecycle_state,
          capabilities,
          parent,
          created_at,
          last_activity_at
        )
        VALUES (
          @id,
          @goalId,
          @runId,
          @providerId,
          @modelLabel,
          @lifecycleState,
          @capabilities,
          @parent,
          @createdAt,
          @lastActivityAt
        )
      `).run({
        ...session,
        capabilities: JSON.stringify(session.capabilities),
        parent: session.parent ? JSON.stringify(session.parent) : null,
      });

      return session;
    },

    updateLifecycleState(id, state) {
      const existing = this.getSession(id);
      if (!existing) {
        throw new Error(`Agent session not found: ${id}`);
      }

      const now = clock();
      db.prepare("UPDATE agent_sessions SET lifecycle_state = ?, last_activity_at = ? WHERE id = ?").run(
        state,
        now,
        id,
      );

      return this.getSession(id)!;
    },

    getSession(id) {
      const row = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
      return row ? mapAgentSessionRow(row) : null;
    },

    listSessionsForGoal(goalId) {
      return db
        .prepare("SELECT * FROM agent_sessions WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(goalId)
        .map(mapAgentSessionRow);
    },

    recordCommand(input) {
      const command: AgentRuntimeCommandRecord = {
        id: randomUUID(),
        ...input,
      };

      db.prepare(`
        INSERT INTO agent_runtime_commands (
          id,
          session_id,
          status,
          safe_command,
          cwd,
          started_at,
          completed_at,
          exit_code,
          diagnostics
        )
        VALUES (
          @id,
          @sessionId,
          @status,
          @safeCommand,
          @cwd,
          @startedAt,
          @completedAt,
          @exitCode,
          @diagnostics
        )
      `).run({
        ...command,
        diagnostics: command.diagnostics ? JSON.stringify(command.diagnostics) : null,
      });
      touchSession(command.sessionId);

      return command;
    },

    createApprovalRequest(input) {
      const approval = {
        id: randomUUID(),
        sessionId: input.sessionId,
        commandId: input.commandId ?? null,
        status: "pending",
        safeSummary: input.safeSummary,
        createdAt: clock(),
        resolvedAt: null,
        resolutionReason: null,
      } satisfies Omit<AgentRuntimeApprovalRequest, "command">;

      db.prepare(`
        INSERT INTO agent_runtime_approvals (
          id,
          session_id,
          command_id,
          status,
          safe_summary,
          created_at,
          resolved_at,
          resolution_reason
        )
        VALUES (
          @id,
          @sessionId,
          @commandId,
          @status,
          @safeSummary,
          @createdAt,
          @resolvedAt,
          @resolutionReason
        )
      `).run(approval);

      return mapApprovalWithCommand(db, approval);
    },

    resolveApprovalRequest(id, status, reason = null) {
      const existing = getApprovalById(db, id);
      if (!existing) {
        throw new Error(`Approval request not found: ${id}`);
      }

      if (existing.status !== "pending") {
        return existing;
      }

      db.prepare(`
        UPDATE agent_runtime_approvals
        SET status = ?, resolved_at = ?, resolution_reason = ?
        WHERE id = ?
      `).run(status, clock(), reason, id);

      return getApprovalById(db, id)!;
    },

    listApprovalRequests(sessionId) {
      return db
        .prepare("SELECT * FROM agent_runtime_approvals WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(sessionId)
        .map((row) => mapAgentRuntimeApprovalRow(db, row));
    },

    recordChildSessionRequest(input) {
      const request: AgentRuntimeChildSessionRequest = {
        id: randomUUID(),
        parentSessionId: input.parentSessionId,
        parentAgentId: input.parentAgentId ?? null,
        childRole: input.childRole,
        taskId: input.taskId ?? null,
        promptSummary: input.promptSummary,
        status: input.status ?? "pending",
        createdAt: clock(),
        resolvedAt: input.resolvedAt ?? null,
        safeReason: input.safeReason ?? null,
      };

      db.prepare(`
        INSERT INTO agent_child_session_requests (
          id,
          parent_session_id,
          parent_agent_id,
          child_role,
          task_id,
          prompt_summary,
          status,
          created_at,
          resolved_at,
          safe_reason
        )
        VALUES (
          @id,
          @parentSessionId,
          @parentAgentId,
          @childRole,
          @taskId,
          @promptSummary,
          @status,
          @createdAt,
          @resolvedAt,
          @safeReason
        )
      `).run(request);

      return request;
    },

    listChildSessionRequests(parentSessionId) {
      return db
        .prepare(
          "SELECT * FROM agent_child_session_requests WHERE parent_session_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .all(parentSessionId)
        .map(mapAgentRuntimeChildSessionRequestRow);
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

function mapAgentSessionRow(row: unknown): AgentRuntimeSession {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    goalId: value.goal_id!,
    runId: value.run_id!,
    providerId: value.provider_id!,
    modelLabel: value.model_label,
    lifecycleState: value.lifecycle_state as AgentSessionLifecycleState,
    capabilities: JSON.parse(value.capabilities!) as AgentRuntimeCapabilities,
    parent: value.parent ? (JSON.parse(value.parent) as AgentRuntimeSessionParent) : null,
    createdAt: value.created_at!,
    lastActivityAt: value.last_activity_at!,
  };
}

function mapAgentRuntimeCommandRow(row: unknown): AgentRuntimeCommandRecord {
  const value = row as Record<string, string | number | null>;
  return {
    id: value.id as string,
    sessionId: value.session_id as string,
    status: value.status as AgentRuntimeCommandStatus,
    safeCommand: value.safe_command as string,
    cwd: value.cwd as string | null,
    startedAt: value.started_at as string | null,
    completedAt: value.completed_at as string | null,
    exitCode: value.exit_code as number | null,
    diagnostics: value.diagnostics
      ? (JSON.parse(value.diagnostics as string) as AgentRuntimeCommandDiagnostics)
      : null,
  };
}

function getCommandById(db: AppDatabase, id: string): AgentRuntimeCommandRecord | null {
  const row = db.prepare("SELECT * FROM agent_runtime_commands WHERE id = ?").get(id);
  return row ? mapAgentRuntimeCommandRow(row) : null;
}

function getApprovalById(db: AppDatabase, id: string): AgentRuntimeApprovalRequest | null {
  const row = db.prepare("SELECT * FROM agent_runtime_approvals WHERE id = ?").get(id);
  return row ? mapAgentRuntimeApprovalRow(db, row) : null;
}

function mapAgentRuntimeApprovalRow(db: AppDatabase, row: unknown): AgentRuntimeApprovalRequest {
  const value = row as Record<string, string | null>;
  return mapApprovalWithCommand(db, {
    id: value.id!,
    sessionId: value.session_id!,
    commandId: value.command_id,
    status: value.status as AgentRuntimeApprovalStatus,
    safeSummary: value.safe_summary!,
    createdAt: value.created_at!,
    resolvedAt: value.resolved_at,
    resolutionReason: value.resolution_reason,
  });
}

function mapApprovalWithCommand(
  db: AppDatabase,
  approval: Omit<AgentRuntimeApprovalRequest, "command">,
): AgentRuntimeApprovalRequest {
  return {
    ...approval,
    command: approval.commandId ? getCommandById(db, approval.commandId) : null,
  };
}

function mapAgentRuntimeChildSessionRequestRow(row: unknown): AgentRuntimeChildSessionRequest {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    parentSessionId: value.parent_session_id!,
    parentAgentId: value.parent_agent_id,
    childRole: value.child_role!,
    taskId: value.task_id,
    promptSummary: value.prompt_summary!,
    status: value.status as AgentRuntimeChildSessionRequestStatus,
    createdAt: value.created_at!,
    resolvedAt: value.resolved_at,
    safeReason: value.safe_reason,
  };
}
