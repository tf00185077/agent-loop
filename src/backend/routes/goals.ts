import { Router } from "express";

import {
  sanitizeStartGoalProviderOverride,
  type Event,
  type StartGoalProviderOverride,
} from "../../domain/index.js";
import type { EventBus } from "../../persistence/event-bus.js";
import type { GoalRepository } from "../../persistence/goal-repository.js";
import type { EventRepository } from "../../persistence/runtime-repositories.js";

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
}

interface GoalRouterDeps {
  goalRepo: GoalRepository;
  eventRepo: EventRepository;
  eventBus: EventBus;
  runtime: RuntimeRunner;
}

export function createGoalRouter(deps: GoalRouterDeps): Router {
  const { goalRepo, eventRepo, eventBus, runtime } = deps;
  const router = Router();

  // POST /api/goals
  router.post("/", (req, res, next) => {
    try {
      const { title, description, priority, agentType } = req.body as Record<
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

      const goal = goalRepo.create({
        title: title.trim(),
        description: description.trim(),
        priority: (priority as never) ?? undefined,
        agentType: (agentType as never) ?? undefined,
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

      // Run lifecycle in background (non-blocking)
      runtime.run(goal.id, parsed.options).catch((err: unknown) => {
        console.error(`Runtime error for goal ${goal.id}:`, err);
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
