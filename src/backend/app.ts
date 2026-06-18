import express from "express";

import type { AppDatabase } from "../persistence/database.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import { createProviderSettingsRepository } from "../persistence/provider-settings-repository.js";
import {
  createEventRepository,
  createRunRepository,
  createStepRepository,
} from "../persistence/runtime-repositories.js";
import { createMockRuntime } from "../runtime/mock-runtime.js";
import { createOpenAICompatibleProvider } from "../runtime/openai-compatible-provider.js";
import { createOpenAILocalAgentProvider } from "../runtime/openai-local-agent-provider.js";
import { loadProviderConfig, type ProviderEnvironment } from "../runtime/provider-config.js";
import { createProviderRuntime } from "../runtime/provider-runtime.js";
import { createGoalRouter } from "./routes/goals.js";
import {
  createProviderSettingsRouter,
  type ProviderSettingsRouterDeps,
} from "./routes/provider-settings.js";

export interface CreateAppOptions {
  env?: ProviderEnvironment;
  codexCliDetection?: ProviderSettingsRouterDeps["codexCliDetection"];
  detectCodexCliCommand?: ProviderSettingsRouterDeps["detectCodexCliCommand"];
  testCodexLocalConnection?: ProviderSettingsRouterDeps["testCodexLocalConnection"];
}

export function createApp(db: AppDatabase, options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json());

  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const eventRepo = createEventRepository(db);
  const providerSettingsRepo = createProviderSettingsRepository(db);
  const runtime = createRuntimeFromEnvironment({
    env: options.env ?? process.env,
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/goals", createGoalRouter({ goalRepo, eventRepo, runtime }));
  app.use(
    "/api/provider-settings",
    createProviderSettingsRouter({
      providerSettingsRepo,
      codexCliDetection: options.codexCliDetection,
      detectCodexCliCommand: options.detectCodexCliCommand,
      testCodexLocalConnection: options.testCodexLocalConnection,
    }),
  );

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: message });
    },
  );

  return app;
}

type RuntimeRepositories = Parameters<typeof createMockRuntime>[0];

interface CreateRuntimeFromEnvironmentDeps extends RuntimeRepositories {
  env: ProviderEnvironment;
}

function createRuntimeFromEnvironment(deps: CreateRuntimeFromEnvironmentDeps) {
  const { env, goalRepo, runRepo, stepRepo, eventRepo } = deps;
  const config = loadProviderConfig(env);

  if (config.provider === "mock") {
    return createMockRuntime({ goalRepo, runRepo, stepRepo, eventRepo });
  }

  const provider =
    config.provider === "openai-local-agent"
      ? createOpenAILocalAgentProvider({ config })
      : createOpenAICompatibleProvider({ config });

  return createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider,
  });
}
