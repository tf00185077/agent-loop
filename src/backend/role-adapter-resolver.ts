import type {
  AgentAssignableRole,
  AgentRuntimeAdapter,
  ProviderSettings,
} from "../domain/index.js";
import { resolveCliCommandPath } from "../runtime/cli/cli-command-path.js";
import { createMockRuntimeAdapter } from "../runtime/mock/mock-runtime-adapter.js";
import {
  detectClaudeCliCommand,
  type ClaudeCliDetectionOptions,
  type ClaudeCliDetectionResult,
} from "../runtime/providers/claude/claude-cli-detection.js";
import {
  createClaudeRuntimeAdapter,
  type ClaudeRuntimeCapabilityProbe,
  type ClaudeRuntimeSessionRunner,
} from "../runtime/providers/claude/claude-runtime-adapter.js";
import {
  resolveCodexCommandPath,
  type ResolveCodexCommandPathOptions,
} from "../runtime/providers/codex/codex-command-path.js";
import {
  createCodexRuntimeAdapter,
  type CodexRuntimeCapabilityProbe,
  type CodexRuntimeSessionRunner,
} from "../runtime/providers/codex/codex-runtime-adapter.js";

export interface ResolvedRoleAgent {
  adapter: AgentRuntimeAdapter;
  providerId: string;
  modelLabel: string | null;
}

/**
 * Resolves the user-configured agent for a child role, or null when the role
 * has no assignment (caller keeps the goal's default adapter). Backend-only:
 * supervisor output never participates in resolution.
 */
export type RoleAdapterResolver = (role: AgentAssignableRole) => ResolvedRoleAgent | null;

export interface RoleAdapterResolverDeps {
  getSettings: () => ProviderSettings;
  /** Injected adapters (tests/overrides) take precedence over construction. */
  agentRuntimeAdapters?: Partial<Record<"codex-local" | "claude-local" | "mock", AgentRuntimeAdapter>>;
  codexCliDetection?: ResolveCodexCommandPathOptions["detection"];
  detectCodexCliCommand?: ResolveCodexCommandPathOptions["detect"];
  claudeCliDetection?: Omit<ClaudeCliDetectionOptions, "manualPath">;
  detectClaudeCliCommand?: (options: ClaudeCliDetectionOptions) => ClaudeCliDetectionResult;
  codexRuntimeCapabilityProbe?: CodexRuntimeCapabilityProbe;
  codexRuntimeSessionRunner?: CodexRuntimeSessionRunner;
  claudeRuntimeCapabilityProbe?: ClaudeRuntimeCapabilityProbe;
  claudeRuntimeSessionRunner?: ClaudeRuntimeSessionRunner;
}

export function createRoleAdapterResolver(deps: RoleAdapterResolverDeps): RoleAdapterResolver {
  return (role) => {
    const assignment = deps.getSettings().roleAssignments?.[role];
    if (!assignment) {
      return null;
    }
    const modelLabel = assignment.modelLabel.trim() ? assignment.modelLabel.trim() : null;

    const injected = deps.agentRuntimeAdapters?.[assignment.provider];
    if (injected) {
      return { adapter: injected, providerId: assignment.provider, modelLabel };
    }

    if (assignment.provider === "mock") {
      return { adapter: createMockRuntimeAdapter(), providerId: "mock", modelLabel };
    }

    if (assignment.provider === "codex-local") {
      const resolved = resolveCodexCommandPath({
        savedPath: assignment.commandPath,
        detection: deps.codexCliDetection,
        detect: deps.detectCodexCliCommand,
      });
      return {
        adapter: createCodexRuntimeAdapter({
          commandPath: resolved.commandPath ?? "",
          modelLabel,
          probe: deps.codexRuntimeCapabilityProbe,
          sessionRunner: deps.codexRuntimeSessionRunner,
        }),
        providerId: "codex-local",
        modelLabel,
      };
    }

    const detect = deps.detectClaudeCliCommand ?? detectClaudeCliCommand;
    const resolved = resolveCliCommandPath({
      savedPath: assignment.commandPath,
      detect: (manualPath) => detect({ ...deps.claudeCliDetection, manualPath }),
    });
    return {
      adapter: createClaudeRuntimeAdapter({
        commandPath: resolved.commandPath ?? "",
        modelLabel,
        probe: deps.claudeRuntimeCapabilityProbe,
        sessionRunner: deps.claudeRuntimeSessionRunner,
      }),
      providerId: "claude-local",
      modelLabel,
    };
  };
}
