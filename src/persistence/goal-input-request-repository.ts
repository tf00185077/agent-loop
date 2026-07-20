import { randomUUID } from "node:crypto";

import type {
  GoalInputBudgetName,
  GoalInputMessage,
  GoalInputPhase,
  GoalInputRequest,
  GoalInputRequestPayload,
  GoalInputRequestReason,
  GoalInputRequestStatus,
  GoalInputResponse,
} from "../domain/index.js";
import { budgetGrantReasons } from "../domain/index.js";
import type { AppDatabase } from "./database.js";

export interface CreateGoalInputRequestInput {
  goalId: string;
  reasonCode: GoalInputRequestReason;
  safeSummary: string;
  payload: GoalInputRequestPayload;
}

export interface GoalInputRequestRepository {
  createRequest(input: CreateGoalInputRequestInput): GoalInputRequest;
  getById(id: string): GoalInputRequest | null;
  getPending(goalId: string): GoalInputRequest | null;
  listForGoal(goalId: string): GoalInputRequest[];
  resolve(
    id: string,
    status: Exclude<GoalInputRequestStatus, "pending">,
    response: GoalInputResponse | null,
  ): GoalInputRequest;
  /** Append a conversation message and set the new phase in one durable write. */
  appendMessage(id: string, message: GoalInputMessage, phase: GoalInputPhase): GoalInputRequest;
  /**
   * Sum of budget grants from accepted responses for one bound: explicit
   * `extend_budget` extensions, plus the implicit minimal grant (1) that an
   * accepted `provide_guidance` carries for budget-exhaustion reasons so the
   * resumed loop can act. Guidance on the circuit breaker or a supervisor
   * question grants nothing — neither is a budget.
   */
  sumAcceptedExtensions(goalId: string, budgetName: GoalInputBudgetName): number;
}

export interface GoalInputRequestRepositoryOptions {
  now?: () => string;
}

export function createGoalInputRequestRepository(
  db: AppDatabase,
  options: GoalInputRequestRepositoryOptions = {},
): GoalInputRequestRepository {
  const now = options.now ?? (() => new Date().toISOString());

  const getById = (id: string): GoalInputRequest | null => {
    const row = db.prepare("SELECT * FROM goal_input_requests WHERE id = ?").get(id);
    return row ? mapRow(row) : null;
  };

  return {
    createRequest(input) {
      const pending = db
        .prepare("SELECT id FROM goal_input_requests WHERE goal_id = ? AND status = 'pending'")
        .get(input.goalId) as { id: string } | undefined;
      if (pending) {
        throw new Error(`Goal ${input.goalId} already has a pending input request (${pending.id}).`);
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO goal_input_requests (
          id, goal_id, reason_code, safe_summary, payload, status, response, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
      `).run(id, input.goalId, input.reasonCode, input.safeSummary, JSON.stringify(input.payload), now());
      return getById(id)!;
    },
    getById,
    getPending(goalId) {
      const row = db
        .prepare("SELECT * FROM goal_input_requests WHERE goal_id = ? AND status = 'pending'")
        .get(goalId);
      return row ? mapRow(row) : null;
    },
    listForGoal(goalId) {
      return db
        .prepare("SELECT * FROM goal_input_requests WHERE goal_id = ? ORDER BY created_at, rowid")
        .all(goalId)
        .map(mapRow);
    },
    resolve(id, status, response) {
      const existing = getById(id);
      if (!existing) throw new Error(`Goal input request not found: ${id}`);
      if (existing.status !== "pending") {
        throw new Error(`Goal input request ${id} is not pending (status: ${existing.status}).`);
      }
      db.prepare(`
        UPDATE goal_input_requests SET status = ?, response = ?, resolved_at = ? WHERE id = ?
      `).run(status, response ? JSON.stringify(response) : null, now(), id);
      return getById(id)!;
    },
    appendMessage(id, message, phase) {
      const existing = getById(id);
      if (!existing) throw new Error(`Goal input request not found: ${id}`);
      if (existing.status !== "pending") {
        throw new Error(`Goal input request ${id} is not pending (status: ${existing.status}).`);
      }
      const payload = {
        ...existing.payload,
        thread: [...(existing.payload.thread ?? []), message],
        phase,
      };
      db.prepare("UPDATE goal_input_requests SET payload = ? WHERE id = ?").run(JSON.stringify(payload), id);
      return getById(id)!;
    },
    sumAcceptedExtensions(goalId, budgetName) {
      let total = 0;
      for (const request of this.listForGoal(goalId)) {
        if (request.status !== "accepted" || request.payload.budgetName !== budgetName) continue;
        if (request.response?.decision === "extend_budget") {
          total += request.response.extension;
        } else if (
          request.response?.decision === "provide_guidance" &&
          budgetGrantReasons.includes(request.reasonCode)
        ) {
          total += 1;
        }
      }
      return total;
    },
  };
}

function mapRow(row: unknown): GoalInputRequest {
  const value = row as Record<string, string | null>;
  return {
    id: value.id!,
    goalId: value.goal_id!,
    reasonCode: value.reason_code as GoalInputRequestReason,
    safeSummary: value.safe_summary!,
    payload: JSON.parse(value.payload!) as GoalInputRequestPayload,
    status: value.status as GoalInputRequestStatus,
    response: value.response ? (JSON.parse(value.response) as GoalInputResponse) : null,
    createdAt: value.created_at!,
    resolvedAt: value.resolved_at,
  };
}
