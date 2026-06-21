import type { ProviderStatus } from "../domain/index.js";
import {
  detectCodexCliCommand,
  type CodexCliDetectionOptions,
  type CodexCliDetectionResult,
  type CodexCliDetectionSource,
} from "./codex-cli-detection.js";

export interface ResolveCodexCommandPathOptions {
  /** The currently saved Codex command path, if any. */
  savedPath: string | null;
  /** Detection knobs (PATH/common-location overrides). manualPath is supplied internally. */
  detection?: Omit<CodexCliDetectionOptions, "manualPath">;
  /** Injectable detector, primarily for tests. */
  detect?: (options: CodexCliDetectionOptions) => CodexCliDetectionResult;
  /**
   * Called with the newly detected path when it differs from savedPath, so the
   * caller can persist the self-healed value. Not called when the saved path is
   * still valid or when nothing resolves.
   */
  persist?: (commandPath: string) => void;
}

export interface ResolveCodexCommandPathResult {
  /** Resolved usable command path, or null when none could be found. */
  commandPath: string | null;
  /** True when the resolved path differs from the saved path (i.e. self-healed). */
  changed: boolean;
  source: CodexCliDetectionSource;
  status: ProviderStatus;
}

/**
 * Validates the saved Codex command path and re-detects when it is stale.
 *
 * The saved path is offered to detection as the manual candidate: if it still
 * exists and can execute Codex it is reused unchanged; otherwise detection
 * falls back to PATH and common install locations. When a different path is
 * found, `persist` is invoked so the caller can update saved settings instead
 * of spawning a stale path. When nothing resolves, the returned status carries
 * the not-found condition.
 */
export function resolveCodexCommandPath(
  options: ResolveCodexCommandPathOptions,
): ResolveCodexCommandPathResult {
  const detect = options.detect ?? detectCodexCliCommand;
  const result = detect({ ...options.detection, manualPath: options.savedPath });

  const changed = result.commandPath !== null && result.commandPath !== options.savedPath;
  if (changed && result.commandPath) {
    options.persist?.(result.commandPath);
  }

  return {
    commandPath: result.commandPath,
    changed,
    source: result.source,
    status: result.status,
  };
}
