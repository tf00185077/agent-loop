import { Router } from "express";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  sanitizeStartGoalProviderOverride,
  type Event,
  type GoalInputRequest,
  type StartGoalProviderOverride,
} from "../../domain/index.js";
import type { EventBus } from "../../persistence/event-bus.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type { GoalInputRequestRepository } from "../../persistence/goal-input-request-repository.js";
import type { ManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import type { RespondToGoalInputRequestResult } from "../../runtime/agent-session/agent-session-manager.js";
import type {
  AgentSessionRepository,
  EventRepository,
} from "../../persistence/runtime-repositories.js";
import {
  sanitizeAgentRuntimeApprovalRequest,
  sanitizeAgentRuntimeChildSessionRequest,
  sanitizeAgentRuntimeDelegationRequest,
  sanitizeAgentRuntimeSession,
  sanitizeControlPlaneText,
} from "../../runtime/safety/agent-runtime-control-plane-sanitizer.js";
import { projectManagedTaskContext } from "../../runtime/agent-session/managed-context-projection.js";
import { projectPlanningEpochs } from "../../runtime/agent-session/planning-epoch-projection.js";
import { projectAgentLiveStatus } from "../../runtime/agent-session/agent-live-status.js";
import { recordUnhandledRuntimeFailure } from "../../runtime/agent-session/unhandled-failure.js";

const TERMINAL_EVENT_TYPES = new Set<Event["type"]>([
  "goal.completed",
  "goal.blocked",
  "error",
]);

interface RuntimeRunOptions {
  providerOverride?: StartGoalProviderOverride;
}

interface RuntimeRunner {
  run(goalId: string, options?: RuntimeRunOptions): Promise<unknown>;
  /** Managed runtimes route caller responses through the session manager. */
  respondToInput?(goalId: string, requestId: string, body: unknown): Promise<RespondToGoalInputRequestResult>;
}

interface GoalRouterDeps {
  goalRepo: GoalRepository;
  eventRepo: EventRepository;
  eventBus: EventBus;
  runtime: RuntimeRunner;
  agentSessionRepo: AgentSessionRepository;
  managedTaskRepo?: ManagedTaskRepository;
  goalInputRequestRepo?: GoalInputRequestRepository;
}

export function createGoalRouter(deps: GoalRouterDeps): Router {
  const { goalRepo, eventRepo, eventBus, runtime, agentSessionRepo } = deps;
  const router = Router();

  // POST /api/goals
  router.post("/", (req, res, next) => {
    try {
      const { title, description, priority, agentType, confirmationPolicy, workspace } = req.body as Record<
        string,
        unknown
      >;
      if (typeof title !== "string" || !title.trim()) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      if (typeof description !== "string" || !description.trim()) {
        res.status(400).json({ error: "description is required" });
        return;
      }
      if (confirmationPolicy !== undefined && confirmationPolicy !== "off" && confirmationPolicy !== "required") {
        res.status(400).json({ error: "confirmationPolicy must be 'off' or 'required'" });
        return;
      }
      const workspaceCheck = validateWorkspace(workspace);
      if (!workspaceCheck.ok) {
        res.status(400).json({ error: workspaceCheck.error });
        return;
      }

      const goal = goalRepo.create({
        title: title.trim(),
        description: description.trim(),
        priority: (priority as never) ?? undefined,
        agentType: (agentType as never) ?? undefined,
        confirmationPolicy: (confirmationPolicy as never) ?? undefined,
        workspace: workspaceCheck.workspace,
      });

      eventRepo.create({
        goalId: goal.id,
        type: "goal.created",
        message: `Goal created: ${goal.title}`,
        data: { goalId: goal.id },
      });

      res.status(201).json(goal);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/goals
  router.get("/", (_req, res, next) => {
    try {
      res.json(goalRepo.list());
    } catch (err) {
      next(err);
    }
  });

  // GET /api/goals/:id
  router.get("/:id", (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      res.json(goal);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/goals/:id/input-request — the pending caller escalation, if any.
  router.get("/:id/input-request", (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      const pending = deps.goalInputRequestRepo?.getPending(goal.id);
      if (!pending) {
        res.status(404).json({ error: "No pending input request for this goal" });
        return;
      }
      res.json(sanitizeGoalInputRequest(pending));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/goals/:id/input-request/:requestId/respond — caller decision.
  router.post("/:id/input-request/:requestId/respond", async (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      if (!runtime.respondToInput) {
        res.status(409).json({ error: "The active runtime does not support escalation responses" });
        return;
      }
      const result = await runtime.respondToInput(goal.id, req.params.requestId, req.body);
      if (result.ok) {
        res.json({ outcome: result.outcome, request: sanitizeGoalInputRequest(result.request) });
        return;
      }
      const status = result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 400;
      res.status(status).json({
        error: result.safeReason,
        ...(result.standing ? { standing: sanitizeGoalInputRequest(result.standing) } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/goals/:id/events
  router.get("/:id/events", (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      res.json(eventRepo.listForGoal(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/goals/:id/agent-session
  router.get("/:id/agent-session", (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const sessions = agentSessionRepo.listSessionsForGoal(goal.id);
      const session = sessions.at(-1) ?? null;
      const events = eventRepo.listForGoal(goal.id);
      const liveStatusEvents = events.map((event) => ({
        ...event,
        message: sanitizeControlPlaneText(event.message),
        data: {},
      }));
      const mergeOutcomes = events
        .filter((event) => event.data.runtimeEventType === "review_merge.apply_outcome")
        .map((event) => ({
          delegationRequestId: stringValue(event.data.delegationRequestId),
          childSessionId: stringValue(event.data.childSessionId),
          outcome: stringValue(event.data.reviewMergeOutcome),
          diffSummary: nullableStringValue(event.data.diffSummary),
          safeSummary: nullableStringValue(event.data.safeSummary),
          fixedTest: recordValue(event.data.fixedTest),
          revertEvidence: recordValue(event.data.revertEvidence),
        }));
      const sanitizedSessions = sessions.map(sanitizeAgentRuntimeSession);
      const approvals = sessions.flatMap((managedSession) =>
        agentSessionRepo.listApprovalRequests(managedSession.id).map(sanitizeAgentRuntimeApprovalRequest));
      const delegationRequests = sessions.flatMap((managedSession) =>
        agentSessionRepo.listDelegationRequests(managedSession.id).map(sanitizeAgentRuntimeDelegationRequest));
      const managedTasks = deps.managedTaskRepo ? projectManagedTaskContext(deps.managedTaskRepo, goal.id) : [];
      res.json({
        session: session ? sanitizeAgentRuntimeSession(session) : null,
        sessions: sanitizedSessions,
        approvals: session ? approvals.filter((approval) => approval.sessionId === session.id) : [],
        childSessionRequests: session
          ? agentSessionRepo
              .listChildSessionRequests(session.id)
              .map(sanitizeAgentRuntimeChildSessionRequest)
          : [],
        delegationRequests,
        mergeOutcomes,
        managedTasks,
        planningEpochs: projectPlanningEpochs(events),
        liveStatus: projectAgentLiveStatus({
          goal,
          sessions: sanitizedSessions,
          approvals,
          delegations: delegationRequests,
          managedTasks,
          events: liveStatusEvents,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/goals/:id/events/stream
  router.get("/:id/events/stream", (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const unsubscribe = eventBus.subscribe(goal.id, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (TERMINAL_EVENT_TYPES.has(event.type)) {
          unsubscribe();
          res.end();
        }
      });

      req.on("close", unsubscribe);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/goals/:id/start
  router.post("/:id/start", async (req, res, next) => {
    try {
      const goal = goalRepo.getById(req.params.id);
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      if (goal.status !== "draft") {
        res
          .status(409)
          .json({ error: `Goal is already in status: ${goal.status}` });
        return;
      }
      const parsed = parseStartGoalBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      // Start async, respond immediately with updated goal
      const started = goalRepo.updateStatus(goal.id, "running", {
        startedAt: new Date().toISOString(),
      });

      // Run lifecycle in background (non-blocking). Any otherwise-unhandled
      // rejection is routed into the durable safety net so the goal cannot be
      // left silently stuck in `running`.
      runtime.run(goal.id, parsed.options).catch((err: unknown) => {
        recordUnhandledRuntimeFailure(
          { goalRepo, eventRepo },
          { kind: "goal", goalId: goal.id, error: err },
        );
      });

      res.json(started);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

type ParseStartGoalBodyResult =
  | { ok: true; options: RuntimeRunOptions }
  | { ok: false; error: string };

function parseStartGoalBody(body: unknown): ParseStartGoalBodyResult {
  if (body === undefined) return { ok: true, options: {} };
  if (!isRecord(body)) return { ok: false, error: "request body must be an object" };
  if (body.providerOverride === undefined) return { ok: true, options: {} };

  const override = parseProviderOverride(body.providerOverride);
  if (!override.ok) return override;
  return {
    ok: true,
    options: {
      providerOverride: sanitizeStartGoalProviderOverride(override.providerOverride),
    },
  };
}

type ParseProviderOverrideResult =
  | { ok: true; providerOverride: StartGoalProviderOverride }
  | { ok: false; error: string };

function parseProviderOverride(value: unknown): ParseProviderOverrideResult {
  if (!isRecord(value)) {
    return { ok: false, error: "providerOverride must be an object" };
  }

  if (value.provider === "mock") {
    return { ok: true, providerOverride: { provider: "mock" } };
  }

  if (value.provider === "codex-local") {
    return {
      ok: true,
      providerOverride: {
        provider: "codex-local",
        modelLabel: typeof value.modelLabel === "string" ? value.modelLabel.trim() : "",
        codexCommandPath:
          typeof value.codexCommandPath === "string" && value.codexCommandPath.trim()
            ? value.codexCommandPath.trim()
            : null,
      },
    };
  }

  if (value.provider === "claude-local") {
    return {
      ok: true,
      providerOverride: {
        provider: "claude-local",
        modelLabel: typeof value.modelLabel === "string" ? value.modelLabel.trim() : "",
        claudeCommandPath:
          typeof value.claudeCommandPath === "string" && value.claudeCommandPath.trim()
            ? value.claudeCommandPath.trim()
            : null,
      },
    };
  }

  return {
    ok: false,
    error: "providerOverride.provider must be mock, codex-local, or claude-local",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A per-goal workspace must be an absolute path to an existing directory. This
 * runs at the create boundary (deterministic validation, not prompt); omitting
 * it keeps the server default.
 */
function validateWorkspace(
  value: unknown,
): { ok: true; workspace: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, workspace: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "workspace must be a string path" };
  }
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    return { ok: false, error: "workspace must be an absolute directory path" };
  }
  let stat;
  try {
    stat = statSync(trimmed);
  } catch {
    return { ok: false, error: `workspace directory does not exist: ${trimmed}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `workspace is not a directory: ${trimmed}` };
  }
  return { ok: true, workspace: trimmed };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

/**
 * Outgoing escalation payloads cross the API boundary: sanitize every
 * free-text field the same way other control-plane text is sanitized.
 */
function sanitizeGoalInputRequest(request: GoalInputRequest): GoalInputRequest {
  return {
    ...request,
    safeSummary: sanitizeControlPlaneText(request.safeSummary) ?? "",
    payload: {
      ...request.payload,
      evidence: request.payload.evidence.map((entry) => sanitizeControlPlaneText(entry) ?? ""),
      remainingGaps: request.payload.remainingGaps.map((gap) => ({
        refs: gap.refs,
        summary: sanitizeControlPlaneText(gap.summary) ?? "",
      })),
      ...(request.payload.thread
        ? {
            thread: request.payload.thread.map((message) => ({
              role: message.role,
              text: sanitizeControlPlaneText(message.text) ?? "",
              at: message.at,
            })),
          }
        : {}),
    },
  };
}
