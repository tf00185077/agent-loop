import { existsSync, readdirSync } from "node:fs";
import { delimiter, posix, win32 } from "node:path";
import { spawnSync } from "node:child_process";

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
  commandSupportsCodexExec?: (path: string) => boolean;
}

export function detectCodexCliCommand(options: CodexCliDetectionOptions = {}): CodexCliDetectionResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const listDirectories = options.listDirectories ?? defaultListDirectories;
  const commandSupportsCodexExec = options.commandSupportsCodexExec ?? defaultCommandSupportsCodexExec;

  const manualPath = normalizeCandidate(options.manualPath);
  if (manualPath && fileExists(manualPath) && commandSupportsCodexExec(manualPath)) {
    return detected(manualPath, "manual", "Codex CLI detected from saved manual path.");
  }

  const pathMatch = findOnPath({ env, platform, fileExists, commandSupportsCodexExec });
  if (pathMatch) {
    return detected(pathMatch, "path", "Codex CLI detected on PATH.");
  }

  const commonMatch = commonCandidatePaths({ env, platform, listDirectories }).find(
    (candidate) => fileExists(candidate) && commandSupportsCodexExec(candidate),
  );
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
  commandSupportsCodexExec: (path: string) => boolean;
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
      if (options.fileExists(candidate) && options.commandSupportsCodexExec(candidate)) return candidate;
    }
  }

  return null;
}

function defaultCommandSupportsCodexExec(path: string): boolean {
  const result = spawnSync(path, ["exec", "--help"], {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(path),
    timeout: 5_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  return result.status === 0 && /codex exec|Run Codex non-interactively/i.test(output);
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
