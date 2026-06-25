import type { ProviderStatus } from "../../domain/index.js";
import type {
  CliCommandDetectionResult,
  CliCommandDetectionSource,
} from "./cli-command-detection.js";

export interface ResolveCliCommandPathOptions {
  /** The currently saved command path for this CLI provider, if any. */
  savedPath: string | null;
  /**
   * Detector closed over its CLI-specific config and knobs. Receives the saved
   * path as the manual candidate and returns the resolved detection result.
   */
  detect: (manualPath: string | null) => CliCommandDetectionResult;
  /**
   * Called with the newly detected path when it differs from savedPath, so the
   * caller can persist the self-healed value. Not called when the saved path is
   * still valid or when nothing resolves.
   */
  persist?: (commandPath: string) => void;
}

export interface ResolveCliCommandPathResult {
  /** Resolved usable command path, or null when none could be found. */
  commandPath: string | null;
  /** True when the resolved path differs from the saved path (i.e. self-healed). */
  changed: boolean;
  source: CliCommandDetectionSource;
  status: ProviderStatus;
}

/**
 * Validates a saved CLI command path and re-detects when it is stale.
 *
 * The saved path is offered to detection as the manual candidate: a still-valid
 * path is reused unchanged; a stale path falls back to PATH and common install
 * locations. When a different path is found, `persist` is invoked so the caller
 * can update saved settings instead of using a stale path. When nothing
 * resolves, the returned status carries the not-found condition.
 */
export function resolveCliCommandPath(
  options: ResolveCliCommandPathOptions,
): ResolveCliCommandPathResult {
  const result = options.detect(options.savedPath);

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
