import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";

import type { ProviderStatus } from "../../domain/index.js";

export type CliCommandDetectionSource = "manual" | "path" | "common" | "none";

export interface CliCommandDetectionResult {
  detected: boolean;
  commandPath: string | null;
  source: CliCommandDetectionSource;
  status: ProviderStatus;
}

export interface CliCommonPathContext {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  listDirectories: (path: string) => string[];
}

/**
 * Per-CLI configuration for the reusable detector. Each subscription-backed
 * local CLI provider supplies command names, a capability probe, common install
 * locations, and status messages instead of reimplementing the search.
 */
export interface CliCommandDetectionConfig {
  /** Candidate command file names to look for on PATH, per platform. */
  commandNames: (platform: NodeJS.Platform) => string[];
  /** Probe that returns true when the path can run the CLI we want. */
  commandSupports: (path: string) => boolean;
  /** Common install locations searched when PATH has no match. */
  commonPaths: (ctx: CliCommonPathContext) => string[];
  messages: {
    notFound: string;
    manual: string;
    path: string;
    common: string;
  };
}

export interface CliCommandDetectionOptions {
  manualPath?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  listDirectories?: (path: string) => string[];
  /** Override the config's capability probe (primarily for tests). */
  commandSupports?: (path: string) => boolean;
}

export function detectCliCommand(
  config: CliCommandDetectionConfig,
  options: CliCommandDetectionOptions = {},
): CliCommandDetectionResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const listDirectories = options.listDirectories ?? defaultListDirectories;
  const commandSupports = options.commandSupports ?? config.commandSupports;

  const manualPath = normalizeCandidate(options.manualPath);
  if (manualPath && fileExists(manualPath) && commandSupports(manualPath)) {
    return detected(manualPath, "manual", config.messages.manual);
  }

  const pathMatch = findOnPath({ config, env, platform, fileExists, commandSupports });
  if (pathMatch) {
    return detected(pathMatch, "path", config.messages.path);
  }

  const commonMatch = config
    .commonPaths({ env, platform, listDirectories })
    .find((candidate) => fileExists(candidate) && commandSupports(candidate));
  if (commonMatch) {
    return detected(commonMatch, "common", config.messages.common);
  }

  return {
    detected: false,
    commandPath: null,
    source: "none",
    status: {
      state: "not_found",
      detected: false,
      checkedAt: null,
      message: config.messages.notFound,
    },
  };
}

function detected(
  commandPath: string,
  source: Exclude<CliCommandDetectionSource, "none">,
  message: string,
): CliCommandDetectionResult {
  return {
    detected: true,
    commandPath,
    source,
    status: { state: "detected", detected: true, checkedAt: null, message },
  };
}

function findOnPath(options: {
  config: CliCommandDetectionConfig;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
  commandSupports: (path: string) => boolean;
}): string | null {
  const pathValue = options.env.PATH ?? options.env.Path ?? options.env.path;
  if (!pathValue) return null;

  const pathApi = options.platform === "win32" ? win32 : posix;
  const separator = options.platform === "win32" ? ";" : ":";
  const commandNames = options.config.commandNames(options.platform);

  for (const dir of pathValue.split(separator).map(normalizeCandidate)) {
    if (!dir) continue;
    for (const commandName of commandNames) {
      const candidate = pathApi.join(dir, commandName);
      if (options.fileExists(candidate) && options.commandSupports(candidate)) return candidate;
    }
  }

  return null;
}

export function normalizeCandidate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^"(.+)"$/, "$1");
}

export function defaultListDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
