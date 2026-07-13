import express from "express";

import {
  type AgentRuntimeAdapter,
  type ProviderSettings,
  type StartGoalProviderOverride,
} from "../domain/index.js";
import type { AppDatabase } from "../persistence/database.js";
import { createEventBus } from "../persistence/event-bus.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import {
  createProviderSettingsRepository,
  type ProviderSettingsRepository,
} from "../persistence/provider-settings-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
  createStepRepository,
} from "../persistence/runtime-repositories.js";
import { resolveCliCommandPath } from "../runtime/cli/cli-command-path.js";
import { createMockRuntime } from "../runtime/mock/mock-runtime.js";
import { createClaudeCliProvider } from "../runtime/providers/claude/claude-cli-provider.js";
import { detectClaudeCliCommand } from "../runtime/providers/claude/claude-cli-detection.js";
import { createCodexCliProvider } from "../runtime/providers/codex/codex-cli-provider.js";
import { resolveCodexCommandPath } from "../runtime/providers/codex/codex-command-path.js";
import {
  createCodexRuntimeAdapter,
  type CodexRuntimeCapabilityProbe,
  type CodexRuntimeSessionRunner,
} from "../runtime/providers/codex/codex-runtime-adapter.js";
import { createOpenAICompatibleProvider } from "../runtime/providers/openai-compatible-provider.js";
import { loadProviderConfig, type ProviderEnvironment } from "../runtime/providers/provider-config.js";
import { createProviderRuntime } from "../runtime/providers/provider-runtime.js";
import {
  createAgentSessionManager,
  type AgentSessionManager,
} from "../runtime/agent-session/agent-session-manager.js";
import { createAgentSessionRouter } from "./routes/agent-sessions.js";
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
  claudeCliDetection?: ProviderSettingsRouterDeps["claudeCliDetection"];
  detectClaudeCliCommand?: ProviderSettingsRouterDeps["detectClaudeCliCommand"];
  claudeCliProviderTimeoutMs?: number;
  agentLoopMaxSteps?: number;
  agentLoopMaxDepth?: number;
  agentLoopMaxScopeAssessmentAttempts?: number;
  agentLoopMaxScopeRefinementRounds?: number;
  agentRuntimeAdapters?: Partial<Record<"codex-local" | "claude-local", AgentRuntimeAdapter>>;
  /** Test seams for the server-constructed Codex runtime adapter. */
  codexRuntimeCapabilityProbe?: CodexRuntimeCapabilityProbe;
  codexRuntimeSessionRunner?: CodexRuntimeSessionRunner;
  maxSupervisorContinuations?: number;
}

export function createApp(db: AppDatabase, options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json());

  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const eventBus = createEventBus();
  const eventRepo = createEventRepository(db, { eventBus });
  const providerSettingsRepo = createProviderSettingsRepository(db);
  const agentSessionManager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    maxSupervisorContinuations: options.maxSupervisorContinuations,
  });
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
    claudeCliDetection: options.claudeCliDetection,
    detectClaudeCliCommand: options.detectClaudeCliCommand,
    claudeCliProviderTimeoutMs: options.claudeCliProviderTimeoutMs,
    codexRuntimeCapabilityProbe: options.codexRuntimeCapabilityProbe,
    codexRuntimeSessionRunner: options.codexRuntimeSessionRunner,
    agentLoopMaxSteps: options.agentLoopMaxSteps,
    agentLoopMaxDepth: options.agentLoopMaxDepth,
    agentLoopMaxScopeAssessmentAttempts: options.agentLoopMaxScopeAssessmentAttempts,
    agentLoopMaxScopeRefinementRounds: options.agentLoopMaxScopeRefinementRounds,
    agentSessionRepo,
    agentSessionManager,
    agentRuntimeAdapters: options.agentRuntimeAdapters,
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/goals", createGoalRouter({ goalRepo, eventRepo, eventBus, runtime, agentSessionRepo }));
  app.use("/api/agent-sessions", createAgentSessionRouter({ agentSessionRepo, agentSessionManager }));
  app.use(
    "/api/provider-settings",
    createProviderSettingsRouter({
      providerSettingsRepo,
      codexCliDetection: options.codexCliDetection,
      detectCodexCliCommand: options.detectCodexCliCommand,
      claudeCliDetection: options.claudeCliDetection,
      detectClaudeCliCommand: options.detectClaudeCliCommand,
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
  agentLoopMaxSteps?: number;
  agentLoopMaxDepth?: number;
  agentLoopMaxScopeAssessmentAttempts?: number;
  agentLoopMaxScopeRefinementRounds?: number;
}

interface CreateRuntimeFromSavedProviderSettingsDeps extends CreateRuntimeFromEnvironmentDeps {
  providerSettingsRepo: ProviderSettingsRepository;
  codexCliDetection?: CreateAppOptions["codexCliDetection"];
  detectCodexCliCommand?: CreateAppOptions["detectCodexCliCommand"];
  codexCliProviderTimeoutMs?: number;
  claudeCliDetection?: CreateAppOptions["claudeCliDetection"];
  detectClaudeCliCommand?: CreateAppOptions["detectClaudeCliCommand"];
  claudeCliProviderTimeoutMs?: number;
  codexRuntimeCapabilityProbe?: CreateAppOptions["codexRuntimeCapabilityProbe"];
  codexRuntimeSessionRunner?: CreateAppOptions["codexRuntimeSessionRunner"];
  agentLoopMaxSteps?: number;
  agentLoopMaxDepth?: number;
  agentLoopMaxScopeAssessmentAttempts?: number;
  agentLoopMaxScopeRefinementRounds?: number;
  agentSessionRepo: ReturnType<typeof createAgentSessionRepository>;
  agentSessionManager: AgentSessionManager;
  agentRuntimeAdapters?: CreateAppOptions["agentRuntimeAdapters"];
}

function createRuntimeFromSavedProviderSettings(
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  return {
    async run(goalId: string, options?: { providerOverride?: StartGoalProviderOverride }) {
      const settings = options?.providerOverride ?? deps.providerSettingsRepo.get();
      const runtime = selectRuntimeForSettings(settings, deps);

      return runtime.run(goalId);
    },
  };
}

function selectRuntimeForSettings(
  settings: ProviderSettings | StartGoalProviderOverride,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  if (settings.provider === "codex-local" || settings.provider === "claude-local") {
    const adapter = deps.agentRuntimeAdapters?.[settings.provider];
    if (adapter) {
      return createRuntimeFromAgentRuntimeAdapter(settings, adapter, deps);
    }
  }

  if (settings.provider === "codex-local") {
    return createRuntimeFromCodexLocalSettings(settings, deps);
  }

  if (settings.provider === "claude-local") {
    return createRuntimeFromClaudeLocalSettings(settings, deps);
  }

  if (deps.providerSettingsRepo.hasSaved()) {
    return createMockRuntime({
      ...deps,
      maxSteps: deps.agentLoopMaxSteps,
      maxDepth: deps.agentLoopMaxDepth,
      maxScopeAssessmentAttempts: deps.agentLoopMaxScopeAssessmentAttempts,
      maxScopeRefinementRounds: deps.agentLoopMaxScopeRefinementRounds,
    });
  }

  return createRuntimeFromEnvironment(deps);
}

function createRuntimeFromAgentRuntimeAdapter(
  settings:
    | Extract<ProviderSettings, { provider: "codex-local" | "claude-local" }>
    | Extract<StartGoalProviderOverride, { provider: "codex-local" | "claude-local" }>,
  adapter: AgentRuntimeAdapter,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  return {
    async run(goalId: string) {
      return deps.agentSessionManager.startManagedSession({
        goalId,
        providerId: settings.provider,
        modelLabel: settings.modelLabel,
        adapter,
      });
    },
  };
}

function createRuntimeFromCodexLocalSettings(
  settings:
    | Extract<ProviderSettings, { provider: "codex-local" }>
    | Extract<StartGoalProviderOverride, { provider: "codex-local" }>,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  // Validate the saved command path and self-heal a stale one before spawning.
  // An empty resolved path flows into the provider, which fails the run with a
  // durable error event rather than spawning a dead path.
  const resolved = resolveCodexCommandPath({
    savedPath: settings.codexCommandPath,
    detection: deps.codexCliDetection,
    detect: deps.detectCodexCliCommand,
    persist:
      "status" in settings
        ? (codexCommandPath) => {
            deps.providerSettingsRepo.save({ ...settings, codexCommandPath });
          }
        : undefined,
  });

  const oneShotRuntime = createProviderRuntime({
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

  // Managed supervisor sessions are the default execution path; fall back to
  // the one-shot provider run with a durable downgrade event when the
  // installed CLI cannot support managed session mode.
  return {
    async run(goalId: string) {
      const adapter = createCodexRuntimeAdapter({
        commandPath: resolved.commandPath ?? "",
        modelLabel: settings.modelLabel,
        probe: deps.codexRuntimeCapabilityProbe,
        sessionRunner: deps.codexRuntimeSessionRunner,
      });
      const capabilities = await adapter.detectCapabilities();
      if (capabilities.eventStreaming) {
        return deps.agentSessionManager.startManagedSession({
          goalId,
          providerId: "codex-local",
          modelLabel: settings.modelLabel,
          adapter,
        });
      }

      deps.eventRepo.create({
        goalId,
        type: "agent.progress",
        message: "Managed session mode is unavailable for Codex Local; running the one-shot provider path.",
        data: {
          provider: "codex-local",
          model: settings.modelLabel,
          runtimeEventType: "runtime.managed_mode_downgraded",
          reason:
            capabilities.unsupportedReasons?.approval ??
            "Codex managed session capability detection failed.",
        },
      });
      return oneShotRuntime.run(goalId);
    },
  };
}

function createRuntimeFromClaudeLocalSettings(
  settings:
    | Extract<ProviderSettings, { provider: "claude-local" }>
    | Extract<StartGoalProviderOverride, { provider: "claude-local" }>,
  deps: CreateRuntimeFromSavedProviderSettingsDeps,
) {
  // Validate the saved command path and self-heal a stale one before spawning;
  // an empty resolved path fails the run with a durable error event.
  const detect = deps.detectClaudeCliCommand ?? detectClaudeCliCommand;
  const resolved = resolveCliCommandPath({
    savedPath: settings.claudeCommandPath,
    detect: (manualPath) => detect({ ...deps.claudeCliDetection, manualPath }),
    persist:
      "status" in settings
        ? (claudeCommandPath) => {
            deps.providerSettingsRepo.save({ ...settings, claudeCommandPath });
          }
        : undefined,
  });

  return createProviderRuntime({
    goalRepo: deps.goalRepo,
    runRepo: deps.runRepo,
    stepRepo: deps.stepRepo,
    eventRepo: deps.eventRepo,
    provider: createClaudeCliProvider({
      config: {
        commandPath: resolved.commandPath ?? "",
        modelLabel: settings.modelLabel,
        timeoutMs: deps.claudeCliProviderTimeoutMs,
      },
    }),
  });
}

function createRuntimeFromEnvironment(deps: CreateRuntimeFromEnvironmentDeps) {
  const { env, goalRepo, runRepo, stepRepo, eventRepo } = deps;
  const config = loadProviderConfig(env);

  if (config.provider === "mock") {
    return createMockRuntime({
      goalRepo,
      runRepo,
      stepRepo,
      eventRepo,
      maxSteps: deps.agentLoopMaxSteps,
      maxDepth: deps.agentLoopMaxDepth,
      maxScopeAssessmentAttempts: deps.agentLoopMaxScopeAssessmentAttempts,
      maxScopeRefinementRounds: deps.agentLoopMaxScopeRefinementRounds,
    });
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
