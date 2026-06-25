import {
  detectCodexCliCommand,
  type CodexCliDetectionOptions,
  type CodexCliDetectionResult,
} from "./codex-cli-detection.js";
import {
  resolveCliCommandPath,
  type ResolveCliCommandPathResult,
} from "../../cli/cli-command-path.js";

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

export type ResolveCodexCommandPathResult = ResolveCliCommandPathResult;

/**
 * Codex-specific wrapper over {@link resolveCliCommandPath}: validates the
 * saved Codex command path and re-detects via `detectCodexCliCommand` when it
 * is stale, persisting the re-detected path through `persist`.
 */
export function resolveCodexCommandPath(
  options: ResolveCodexCommandPathOptions,
): ResolveCodexCommandPathResult {
  const detect = options.detect ?? detectCodexCliCommand;
  return resolveCliCommandPath({
    savedPath: options.savedPath,
    detect: (manualPath) => detect({ ...options.detection, manualPath }),
    persist: options.persist,
  });
}
