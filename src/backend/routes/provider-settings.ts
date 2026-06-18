import { Router } from "express";

import { sanitizeProviderStatus, type ProviderSettings } from "../../domain/index.js";
import type { ProviderSettingsRepository } from "../../persistence/provider-settings-repository.js";
import {
  detectCodexCliCommand,
  type CodexCliDetectionOptions,
  type CodexCliDetectionResult,
} from "../../runtime/codex-cli-detection.js";
import {
  testCodexLocalConnection,
  type CodexLocalConnectionTestOptions,
  type CodexLocalConnectionTestResult,
} from "../../runtime/codex-local-connection-test.js";

export interface ProviderSettingsRouterDeps {
  providerSettingsRepo: ProviderSettingsRepository;
  codexCliDetection?: Omit<CodexCliDetectionOptions, "manualPath">;
  detectCodexCliCommand?: (options: CodexCliDetectionOptions) => CodexCliDetectionResult;
  testCodexLocalConnection?: (
    options: CodexLocalConnectionTestOptions,
  ) => Promise<CodexLocalConnectionTestResult>;
}

export function createProviderSettingsRouter(deps: ProviderSettingsRouterDeps): Router {
  const router = Router();
  const detect = deps.detectCodexCliCommand ?? detectCodexCliCommand;
  const testConnection = deps.testCodexLocalConnection ?? testCodexLocalConnection;

  router.get("/", (_req, res, next) => {
    try {
      res.json(deps.providerSettingsRepo.get());
    } catch (err) {
      next(err);
    }
  });

  router.put("/", (req, res, next) => {
    try {
      const parsed = parseProviderSettings(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      res.json(deps.providerSettingsRepo.save(parsed.settings));
    } catch (err) {
      next(err);
    }
  });

  router.post("/detect", (_req, res, next) => {
    try {
      const settings = deps.providerSettingsRepo.get();
      const result = detect({
        ...(deps.codexCliDetection ?? {}),
        manualPath: settings.provider === "codex-local" ? settings.codexCommandPath : null,
      });
      const safeResult = sanitizeDetectionResult(result);

      if (settings.provider === "codex-local") {
        deps.providerSettingsRepo.save({
          ...settings,
          status: safeResult.status,
        });
      }

      res.json(safeResult);
    } catch (err) {
      next(err);
    }
  });

  router.post("/test", async (_req, res, next) => {
    try {
      const settings = deps.providerSettingsRepo.get();
      if (settings.provider !== "codex-local" || !settings.codexCommandPath) {
        res.status(400).json({
          status: {
            state: "not_found",
            detected: false,
            checkedAt: new Date().toISOString(),
            message: "Codex Local provider settings must include a command path before testing.",
          },
        });
        return;
      }

      const result = await testConnection({
        codexCommandPath: settings.codexCommandPath,
        modelLabel: settings.modelLabel,
      });
      const safeResult = {
        status: sanitizeProviderStatus(result.status),
      };
      deps.providerSettingsRepo.save({
        ...settings,
        status: safeResult.status,
      });

      res.json(safeResult);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function sanitizeDetectionResult(result: CodexCliDetectionResult): CodexCliDetectionResult {
  return {
    ...result,
    commandPath: sanitizeCommandPath(result.commandPath),
    status: sanitizeProviderStatus(result.status),
  };
}

function sanitizeCommandPath(commandPath: string | null): string | null {
  return commandPath
    ? commandPath
        .replace(/\s+--(?:api-key|token|access-token)\s+\S+/gi, "")
        .trim()
    : null;
}

type ParseProviderSettingsResult =
  | { ok: true; settings: ProviderSettings }
  | { ok: false; error: string };

function parseProviderSettings(body: unknown): ParseProviderSettingsResult {
  if (!isRecord(body)) {
    return { ok: false, error: "request body must be an object" };
  }

  if (body.provider === "mock") {
    return {
      ok: true,
      settings: {
        provider: "mock",
        modelLabel: "mock-v1",
        codexCommandPath: null,
        status: {
          state: "not_checked",
          detected: false,
          checkedAt: null,
          message: null,
        },
      },
    };
  }

  if (body.provider === "codex-local") {
    const modelLabel =
      typeof body.modelLabel === "string" && body.modelLabel.trim()
        ? body.modelLabel.trim()
        : "gpt-5-codex-subscription";
    const codexCommandPath =
      typeof body.codexCommandPath === "string" && body.codexCommandPath.trim()
        ? body.codexCommandPath.trim()
        : null;

    return {
      ok: true,
      settings: {
        provider: "codex-local",
        modelLabel,
        codexCommandPath,
        status: {
          state: "not_checked",
          detected: false,
          checkedAt: null,
          message: null,
        },
      },
    };
  }

  return { ok: false, error: "provider must be mock or codex-local" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
