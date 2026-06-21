import { posix, win32 } from "node:path";
import { spawnSync } from "node:child_process";

import {
  detectCliCommand,
  type CliCommandDetectionConfig,
  type CliCommandDetectionResult,
  type CliCommandDetectionSource,
  type CliCommonPathContext,
} from "./cli-command-detection.js";

export type ClaudeCliDetectionSource = CliCommandDetectionSource;
export type ClaudeCliDetectionResult = CliCommandDetectionResult;

export interface ClaudeCliDetectionOptions {
  manualPath?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  listDirectories?: (path: string) => string[];
  commandSupportsClaudePrint?: (path: string) => boolean;
}

const claudeDetectionConfig: CliCommandDetectionConfig = {
  commandNames: (platform) =>
    platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"],
  commandSupports: defaultCommandSupportsClaudePrint,
  commonPaths: claudeCommonCandidatePaths,
  messages: {
    notFound: "Claude CLI was not found. Install Claude Code or enter a manual command path.",
    manual: "Claude CLI detected from saved manual path.",
    path: "Claude CLI detected on PATH.",
    common: "Claude CLI detected in a common local install location.",
  },
};

export function detectClaudeCliCommand(
  options: ClaudeCliDetectionOptions = {},
): ClaudeCliDetectionResult {
  return detectCliCommand(claudeDetectionConfig, {
    manualPath: options.manualPath,
    env: options.env,
    platform: options.platform,
    fileExists: options.fileExists,
    listDirectories: options.listDirectories,
    commandSupports: options.commandSupportsClaudePrint,
  });
}

function defaultCommandSupportsClaudePrint(path: string): boolean {
  const result = spawnSync(path, ["--help"], {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(path),
    timeout: 5_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  return result.status === 0 && /Claude Code|--print/i.test(output);
}

function claudeCommonCandidatePaths(ctx: CliCommonPathContext): string[] {
  if (ctx.platform === "win32") {
    const candidates = [
      ctx.env.APPDATA ? win32.join(ctx.env.APPDATA, "npm", "claude.cmd") : null,
      ctx.env.APPDATA ? win32.join(ctx.env.APPDATA, "npm", "claude.exe") : null,
      ctx.env.LOCALAPPDATA ? win32.join(ctx.env.LOCALAPPDATA, "Programs", "claude", "claude.exe") : null,
      ctx.env.USERPROFILE ? win32.join(ctx.env.USERPROFILE, ".local", "bin", "claude.exe") : null,
    ];
    return candidates.filter((candidate): candidate is string => Boolean(candidate));
  }

  const home = ctx.env.HOME;
  return [
    home ? posix.join(home, ".local", "bin", "claude") : null,
    home ? posix.join(home, ".claude", "local", "claude") : null,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ].filter((candidate): candidate is string => Boolean(candidate));
}
