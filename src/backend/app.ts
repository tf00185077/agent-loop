import express from "express";
import { resolve } from "node:path";

import type { ProviderSettings } from "../domain/index.js";
import type { AppDatabase } from "../persistence/database.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import {
  createProviderSettingsRepository,
  type ProviderSettingsRepository,
} from "../persistence/provider-settings-repository.js";
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
  codexLocalWrapperCommand?: string;
  codexLocalWrapperArgs?: string[];
  codexLocalWrapperTimeoutMs?: number;
}

export function createApp(db: AppDatabase, options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json());

  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const eventRepo = createEventRepository(db);
  const providerSettingsRepo = createProviderSettingsRepository(db);
  const runtime = createRuntimeFromSavedProviderSettings({
    env: options.env ?? process.env,
    providerSettingsRepo,
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    codexLocalWrapperCommand: options.codexLocalWrapperCommand,
    codexLocalWrapperArgs: options.codexLocalWrapperArgs,
    codexLocalWrapperTimeoutMs: options.codexLocalWrapperTimeoutMs,
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

interface CreateRuntimeFromSavedProviderSettingsDeps extends CreateRuntimeFromEnvironmentDeps {
  providerSettingsRepo: ProviderSettingsRepository;
  codexLocalWrapperCommand?: string;
  codexLocalWrapperArgs?: string[];
  codexLocalWrapperTimeoutMs?: number;
}

function createRuntimeFromSavedProviderSettings(
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  return {
    async run(goalId: string) {
      const settings = deps.providerSettingsRepo.get();
      const runtime =
        settings.provider === "codex-local"
          ? createRuntimeFromCodexLocalSettings(settings, deps)
          : createRuntimeFromEnvironment(deps);

      return runtime.run(goalId);
    },
  };
}

function createRuntimeFromCodexLocalSettings(
  settings: Extract<ProviderSettings, { provider: "codex-local" }>,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  return createProviderRuntime({
    goalRepo: deps.goalRepo,
    runRepo: deps.runRepo,
    stepRepo: deps.stepRepo,
    eventRepo: deps.eventRepo,
    provider: createOpenAILocalAgentProvider({
      config: {
        provider: "openai-local-agent",
        command: deps.codexLocalWrapperCommand ?? process.execPath,
        args: deps.codexLocalWrapperArgs ?? [
          resolve("scripts", "codex-local-agent-wrapper.mjs"),
        ],
        model: settings.modelLabel,
        timeoutMs: deps.codexLocalWrapperTimeoutMs ?? 120_000,
        env: {
          AUTO_AGENT_CODEX_COMMAND_PATH: settings.codexCommandPath ?? "",
          AUTO_AGENT_OPENAI_LOCAL_MODEL: settings.modelLabel,
        },
      },
    }),
  });
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
