import { posix, win32 } from "node:path";
import { spawnSync } from "node:child_process";

import {
  detectCliCommand,
  type CliCommandDetectionConfig,
  type CliCommandDetectionResult,
  type CliCommandDetectionSource,
  type CliCommonPathContext,
} from "./cli-command-detection.js";

export type CodexCliDetectionSource = CliCommandDetectionSource;
export type CodexCliDetectionResult = CliCommandDetectionResult;

export interface CodexCliDetectionOptions {
  manualPath?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  listDirectories?: (path: string) => string[];
  commandSupportsCodexExec?: (path: string) => boolean;
}

const codexDetectionConfig: CliCommandDetectionConfig = {
  commandNames: (platform) =>
    platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"],
  commandSupports: defaultCommandSupportsCodexExec,
  commonPaths: codexCommonCandidatePaths,
  messages: {
    notFound: "Codex CLI was not found. Install Codex CLI or enter a manual command path.",
    manual: "Codex CLI detected from saved manual path.",
    path: "Codex CLI detected on PATH.",
    common: "Codex CLI detected in a common local install location.",
  },
};

export function detectCodexCliCommand(
  options: CodexCliDetectionOptions = {},
): CodexCliDetectionResult {
  return detectCliCommand(codexDetectionConfig, {
    manualPath: options.manualPath,
    env: options.env,
    platform: options.platform,
    fileExists: options.fileExists,
    listDirectories: options.listDirectories,
    commandSupports: options.commandSupportsCodexExec,
  });
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

function codexCommonCandidatePaths(ctx: CliCommonPathContext): string[] {
  if (ctx.platform === "win32") {
    const candidates = [
      ctx.env.APPDATA ? win32.join(ctx.env.APPDATA, "npm", "codex.cmd") : null,
      ctx.env.APPDATA ? win32.join(ctx.env.APPDATA, "npm", "codex.exe") : null,
      ctx.env.LOCALAPPDATA ? win32.join(ctx.env.LOCALAPPDATA, "Programs", "Codex", "codex.exe") : null,
      ctx.env.USERPROFILE ? win32.join(ctx.env.USERPROFILE, ".codex", "bin", "codex.exe") : null,
      ...windowsVsCodeExtensionCandidates(ctx.env.USERPROFILE, ctx.listDirectories),
    ];
    return candidates.filter((candidate): candidate is string => Boolean(candidate));
  }

  const home = ctx.env.HOME;
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
