import express from "express";

import { type ProviderSettings } from "../domain/index.js";
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
import { createCodexCliProvider } from "../runtime/codex-cli-provider.js";
import { resolveCodexCommandPath } from "../runtime/codex-command-path.js";
import { createMockRuntime } from "../runtime/mock-runtime.js";
import { createOpenAICompatibleProvider } from "../runtime/openai-compatible-provider.js";
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
  loadCodexModelCatalog?: ProviderSettingsRouterDeps["loadCodexModelCatalog"];
  codexCliProviderTimeoutMs?: number;
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
    codexCliDetection: options.codexCliDetection,
    detectCodexCliCommand: options.detectCodexCliCommand,
    codexCliProviderTimeoutMs: options.codexCliProviderTimeoutMs,
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
      loadCodexModelCatalog: options.loadCodexModelCatalog,
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
  codexCliDetection?: CreateAppOptions["codexCliDetection"];
  detectCodexCliCommand?: CreateAppOptions["detectCodexCliCommand"];
  codexCliProviderTimeoutMs?: number;
}

function createRuntimeFromSavedProviderSettings(
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  return {
    async run(goalId: string) {
      const settings = deps.providerSettingsRepo.get();
      const runtime = selectRuntimeForSettings(settings, deps);

      return runtime.run(goalId);
    },
  };
}

function selectRuntimeForSettings(
  settings: ProviderSettings,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  if (settings.provider === "codex-local") {
    return createRuntimeFromCodexLocalSettings(settings, deps);
  }

  if (deps.providerSettingsRepo.hasSaved()) {
    return createMockRuntime(deps);
  }

  return createRuntimeFromEnvironment(deps);
}

function createRuntimeFromCodexLocalSettings(
  settings: Extract<ProviderSettings, { provider: "codex-local" }>,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  // Validate the saved command path and self-heal a stale one before spawning.
  // An empty resolved path flows into the provider, which fails the run with a
  // durable error event rather than spawning a dead path.
  const resolved = resolveCodexCommandPath({
    savedPath: settings.codexCommandPath,
    detection: deps.codexCliDetection,
    detect: deps.detectCodexCliCommand,
    persist: (codexCommandPath) => {
      deps.providerSettingsRepo.save({ ...settings, codexCommandPath });
    },
  });

  return createProviderRuntime({
    goalRepo: deps.goalRepo,
    runRepo: deps.runRepo,
    stepRepo: deps.stepRepo,
    eventRepo: deps.eventRepo,
    provider: createCodexCliProvider({
      config: {
        commandPath: resolved.commandPath ?? "",
        modelLabel: settings.modelLabel,
        timeoutMs: deps.codexCliProviderTimeoutMs,
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

  const provider = createOpenAICompatibleProvider({ config });

  return createProviderRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    provider,
  });
}
