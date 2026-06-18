import { existsSync, readdirSync } from "node:fs";
import { delimiter, posix, win32 } from "node:path";

import type { ProviderStatus } from "../domain/index.js";

export type CodexCliDetectionSource = "manual" | "path" | "common" | "none";

export interface CodexCliDetectionResult {
  detected: boolean;
  commandPath: string | null;
  source: CodexCliDetectionSource;
  status: ProviderStatus;
}

export interface CodexCliDetectionOptions {
  manualPath?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  listDirectories?: (path: string) => string[];
}

export function detectCodexCliCommand(options: CodexCliDetectionOptions = {}): CodexCliDetectionResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const listDirectories = options.listDirectories ?? defaultListDirectories;

  const manualPath = normalizeCandidate(options.manualPath);
  if (manualPath && fileExists(manualPath)) {
    return detected(manualPath, "manual", "Codex CLI detected from saved manual path.");
  }

  const pathMatch = findOnPath({ env, platform, fileExists });
  if (pathMatch) {
    return detected(pathMatch, "path", "Codex CLI detected on PATH.");
  }

  const commonMatch = commonCandidatePaths({ env, platform, listDirectories }).find(fileExists);
  if (commonMatch) {
    return detected(commonMatch, "common", "Codex CLI detected in a common local install location.");
  }

  return {
    detected: false,
    commandPath: null,
    source: "none",
    status: {
      state: "not_found",
      detected: false,
      checkedAt: null,
      message: "Codex CLI was not found. Install Codex CLI or enter a manual command path.",
    },
  };
}

function detected(
  commandPath: string,
  source: Exclude<CodexCliDetectionSource, "none">,
  message: string,
): CodexCliDetectionResult {
  return {
    detected: true,
    commandPath,
    source,
    status: {
      state: "detected",
      detected: true,
      checkedAt: null,
      message,
    },
  };
}

function findOnPath(options: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  fileExists: (path: string) => boolean;
}): string | null {
  const pathValue = options.env.PATH ?? options.env.Path ?? options.env.path;
  if (!pathValue) return null;

  const pathApi = options.platform === "win32" ? win32 : posix;
  const separator = options.platform === "win32" ? ";" : delimiter;
  const commandNames = options.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];

  for (const dir of pathValue.split(separator).map(normalizeCandidate)) {
    if (!dir) continue;
    for (const commandName of commandNames) {
      const candidate = pathApi.join(dir, commandName);
      if (options.fileExists(candidate)) return candidate;
    }
  }

  return null;
}

function commonCandidatePaths(options: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  listDirectories: (path: string) => string[];
}): string[] {
  if (options.platform === "win32") {
    const candidates = [
      options.env.APPDATA ? win32.join(options.env.APPDATA, "npm", "codex.cmd") : null,
      options.env.APPDATA ? win32.join(options.env.APPDATA, "npm", "codex.exe") : null,
      options.env.LOCALAPPDATA ? win32.join(options.env.LOCALAPPDATA, "Programs", "Codex", "codex.exe") : null,
      options.env.USERPROFILE ? win32.join(options.env.USERPROFILE, ".codex", "bin", "codex.exe") : null,
      ...windowsVsCodeExtensionCandidates(options.env.USERPROFILE, options.listDirectories),
    ];
    return candidates.filter((candidate): candidate is string => Boolean(candidate));
  }

  const home = options.env.HOME;
  return [
    home ? posix.join(home, ".local", "bin", "codex") : null,
    home ? posix.join(home, ".codex", "bin", "codex") : null,
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function windowsVsCodeExtensionCandidates(
  userProfile: string | undefined,
  listDirectories: (path: string) => string[],
): string[] {
  if (!userProfile) return [];

  const extensionsDir = win32.join(userProfile, ".vscode", "extensions");
  return listDirectories(extensionsDir)
    .filter((name) => name.startsWith("openai.chatgpt-"))
    .map((name) => win32.join(extensionsDir, name, "bin", "windows-x86_64", "codex.exe"));
}

function normalizeCandidate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^"(.+)"$/, "$1");
}

function defaultListDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
