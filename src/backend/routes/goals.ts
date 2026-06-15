import { Router } from "express";

import type { GoalRepository } from "../../persistence/goal-repository.js";
import type { EventRepository } from "../../persistence/runtime-repositories.js";
import type { MockRuntime } from "../../runtime/mock-runtime.js";

interface GoalRouterDeps {
  goalRepo: GoalRepository;
  eventRepo: EventRepository;
  runtime: MockRuntime;
}

export function createGoalRouter(deps: GoalRouterDeps): Router {
  const { goalRepo, eventRepo, runtime } = deps;
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

      // Start async, respond immediately with updated goal
      const started = goalRepo.updateStatus(goal.id, "running", {
        startedAt: new Date().toISOString(),
      });

      // Run mock lifecycle in background (non-blocking)
      runtime.run(goal.id).catch((err: unknown) => {
        console.error(`Mock runtime error for goal ${goal.id}:`, err);
      });

      res.json(started);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
