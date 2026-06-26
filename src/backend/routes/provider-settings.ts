import { Router } from "express";

import {
  sanitizeProviderStatus,
  type CodexModelCatalogResult,
  type ProviderSettings,
} from "../../domain/index.js";
import type { ProviderSettingsRepository } from "../../persistence/provider-settings-repository.js";
import {
  detectCodexCliCommand,
  type CodexCliDetectionOptions,
  type CodexCliDetectionResult,
} from "../../runtime/providers/codex/codex-cli-detection.js";
import {
  detectClaudeCliCommand,
  type ClaudeCliDetectionOptions,
  type ClaudeCliDetectionResult,
} from "../../runtime/providers/claude/claude-cli-detection.js";
import {
  testCodexLocalConnection,
  type CodexLocalConnectionTestOptions,
  type CodexLocalConnectionTestResult,
} from "../../runtime/providers/codex/codex-local-connection-test.js";
import {
  loadCodexModelCatalog,
  type CodexModelCatalogOptions,
} from "../../runtime/providers/codex/codex-local-model-catalog.js";

export interface ProviderSettingsRouterDeps {
  providerSettingsRepo: ProviderSettingsRepository;
  codexCliDetection?: Omit<CodexCliDetectionOptions, "manualPath">;
  detectCodexCliCommand?: (options: CodexCliDetectionOptions) => CodexCliDetectionResult;
  claudeCliDetection?: Omit<ClaudeCliDetectionOptions, "manualPath">;
  detectClaudeCliCommand?: (options: ClaudeCliDetectionOptions) => ClaudeCliDetectionResult;
  testCodexLocalConnection?: (
    options: CodexLocalConnectionTestOptions,
  ) => Promise<CodexLocalConnectionTestResult>;
  loadCodexModelCatalog?: (
    options: CodexModelCatalogOptions,
  ) => Promise<CodexModelCatalogResult>;
}

export function createProviderSettingsRouter(deps: ProviderSettingsRouterDeps): Router {
  const router = Router();
  const detect = deps.detectCodexCliCommand ?? detectCodexCliCommand;
  const detectClaude = deps.detectClaudeCliCommand ?? detectClaudeCliCommand;
  const testConnection = deps.testCodexLocalConnection ?? testCodexLocalConnection;
  const loadCatalog = deps.loadCodexModelCatalog ?? loadCodexModelCatalog;

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

  router.post("/detect", (req, res, next) => {
    try {
      const settings = deps.providerSettingsRepo.get();
      const override = parseDetectProviderInput(req.body);
      if (!override.ok) {
        res.status(400).json({ error: override.error });
        return;
      }

      if (override.input?.provider === "claude-local") {
        const result = detectClaude({
          ...(deps.claudeCliDetection ?? {}),
          manualPath: override.input.claudeCommandPath,
        });
        res.json(sanitizeDetectionResult(result));
        return;
      }

      if (override.input?.provider === "codex-local") {
        const result = detect({
          ...(deps.codexCliDetection ?? {}),
          manualPath: override.input.codexCommandPath,
        });
        res.json(sanitizeDetectionResult(result));
        return;
      }

      if (settings.provider === "claude-local") {
        const result = detectClaude({
          ...(deps.claudeCliDetection ?? {}),
          manualPath: settings.claudeCommandPath,
        });
        const safeResult = sanitizeDetectionResult(result);
        deps.providerSettingsRepo.save({
          ...settings,
          claudeCommandPath: safeResult.commandPath ?? settings.claudeCommandPath,
          status: safeResult.status,
        });
        res.json(safeResult);
        return;
      }

      const result = detect({
        ...(deps.codexCliDetection ?? {}),
        manualPath: settings.provider === "codex-local" ? settings.codexCommandPath : null,
      });
      const safeResult = sanitizeDetectionResult(result);

      if (settings.provider === "codex-local") {
        deps.providerSettingsRepo.save({
          ...settings,
          codexCommandPath: safeResult.commandPath ?? settings.codexCommandPath,
          status: safeResult.status,
        });
      }

      res.json(safeResult);
    } catch (err) {
      next(err);
    }
  });

  router.get("/models", async (_req, res, next) => {
    try {
      const settings = deps.providerSettingsRepo.get();
      const savedPath =
        settings.provider === "codex-local" ? settings.codexCommandPath : null;

      const detection = detect({
        ...(deps.codexCliDetection ?? {}),
        manualPath: savedPath,
      });

      if (!detection.commandPath) {
        res.json(catalogUnavailable("Codex CLI was not found. Enter a manual model or command path."));
        return;
      }

      const result = await loadCatalog({
        codexCommandPath: detection.commandPath,
        source: detection.source === "none" ? "manual" : detection.source,
      });

      res.json(sanitizeCatalogResult(result));
    } catch (err) {
      next(err);
    }
  });

  router.get("/runtime-capabilities", (req, res, next) => {
    try {
      const provider = typeof req.query.provider === "string" ? req.query.provider : deps.providerSettingsRepo.get().provider;
      if (provider === "codex-local") {
        // Capability spike, 2026-06-26: local `codex` shims can resolve to
        // legacy/unrelated CLIs, and `exec --json` does not expose a verified
        // backend-mediated approval/resume protocol. Keep approval disabled
        // until the managed Codex adapter detects that protocol explicitly.
        res.json({
          provider,
          capabilities: {
            eventStreaming: true,
            approval: false,
            cancellation: true,
            resume: false,
            childSessions: false,
            unsupportedReasons: {
              approval: "Codex capability spike did not verify a backend-mediated approval resume protocol.",
              resume: "Codex capability spike did not verify resumable managed sessions.",
              child_sessions: "Child-session scheduling is not enabled.",
            },
          },
        });
        return;
      }

      if (provider === "claude-local") {
        res.json({
          provider,
          capabilities: {
            eventStreaming: false,
            approval: false,
            cancellation: true,
            resume: false,
            childSessions: false,
            unsupportedReasons: {
              event_streaming: "Claude Local currently runs through the one-shot provider path.",
              approval: "Claude Local approval bridging is not implemented.",
              child_sessions: "Child-session scheduling is not enabled.",
            },
          },
        });
        return;
      }

      if (provider === "mock") {
        res.json({
          provider,
          capabilities: {
            eventStreaming: true,
            approval: false,
            cancellation: false,
            resume: false,
            childSessions: false,
            unsupportedReasons: {
              approval: "Mock completion provider does not require approval controls.",
              cancellation: "Mock completion provider runs synchronously in tests.",
              child_sessions: "Child-session scheduling is not enabled.",
            },
          },
        });
        return;
      }

      res.status(400).json({ error: "provider must be mock, codex-local, or claude-local" });
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

function catalogUnavailable(message: string): CodexModelCatalogResult {
  return {
    models: [],
    defaultModelSlug: null,
    source: "none",
    status: { state: "unavailable", checkedAt: new Date().toISOString(), message, detail: null },
  };
}

/**
 * Defense-in-depth re-mapping at the API boundary: re-build each model from
 * allowlisted display fields only and redact credential material from the
 * status message. The `detail` field intentionally carries raw Codex CLI output
 * on failures so the dashboard can show the actual error for debugging.
 */
function sanitizeCatalogResult(result: CodexModelCatalogResult): CodexModelCatalogResult {
  return {
    models: result.models.map((model) => ({
      slug: model.slug,
      displayName: model.displayName,
      description: model.description,
      priority: model.priority,
    })),
    defaultModelSlug: result.defaultModelSlug,
    source: result.source,
    status: {
      ...result.status,
      message: result.status.message
        ? sanitizeProviderStatus({
            state: "command_failure",
            detected: false,
            checkedAt: null,
            message: result.status.message,
          }).message
        : null,
      detail: result.status.detail ?? null,
    },
  };
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

type DetectProviderInput =
  | { provider: "codex-local"; codexCommandPath: string | null }
  | { provider: "claude-local"; claudeCommandPath: string | null };

type ParseDetectProviderInputResult =
  | { ok: true; input: DetectProviderInput | null }
  | { ok: false; error: string };

function parseDetectProviderInput(body: unknown): ParseDetectProviderInputResult {
  if (body === undefined || (isRecord(body) && Object.keys(body).length === 0)) {
    return { ok: true, input: null };
  }
  if (!isRecord(body)) return { ok: false, error: "request body must be an object" };

  if (body.provider === "codex-local") {
    return {
      ok: true,
      input: {
        provider: "codex-local",
        codexCommandPath:
          typeof body.codexCommandPath === "string" && body.codexCommandPath.trim()
            ? body.codexCommandPath.trim()
            : null,
      },
    };
  }

  if (body.provider === "claude-local") {
    return {
      ok: true,
      input: {
        provider: "claude-local",
        claudeCommandPath:
          typeof body.claudeCommandPath === "string" && body.claudeCommandPath.trim()
            ? body.claudeCommandPath.trim()
            : null,
      },
    };
  }

  return { ok: false, error: "provider must be codex-local or claude-local" };
}

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
    // A blank model label persists as "" and means "use Codex CLI default".
    // We no longer inject the stale gpt-5-codex-subscription fallback, but an
    // explicitly saved legacy label is preserved (it is read back unchanged and
    // simply not forced as a Codex CLI --model argument at execution time).
    const modelLabel =
      typeof body.modelLabel === "string" ? body.modelLabel.trim() : "";
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

  if (body.provider === "claude-local") {
    // A blank model label persists as "" and means "use Claude CLI default".
    const modelLabel =
      typeof body.modelLabel === "string" ? body.modelLabel.trim() : "";
    const claudeCommandPath =
      typeof body.claudeCommandPath === "string" && body.claudeCommandPath.trim()
        ? body.claudeCommandPath.trim()
        : null;

    return {
      ok: true,
      settings: {
        provider: "claude-local",
        modelLabel,
        claudeCommandPath,
        status: {
          state: "not_checked",
          detected: false,
          checkedAt: null,
          message: null,
        },
      },
    };
  }

  return { ok: false, error: "provider must be mock, codex-local, or claude-local" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
