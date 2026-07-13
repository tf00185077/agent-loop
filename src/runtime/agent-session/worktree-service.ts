import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { AgentRuntimeWorktreeMetadata } from "../../domain/index.js";

export interface WorktreeService {
  createChildWorktree(input: CreateChildWorktreeInput): Promise<AgentRuntimeWorktreeMetadata>;
}

export interface CreateChildWorktreeInput {
  parentCwd: string;
  childSessionId: string;
}

export interface GitWorktreeServiceOptions {
  baseDir?: string;
  runGit?: GitRunner;
}

export type GitRunner = (input: { cwd: string; args: string[] }) => { status: number | null; stderr?: string };

export function createGitWorktreeService(options: GitWorktreeServiceOptions = {}): WorktreeService {
  const runGit = options.runGit ?? defaultGitRunner;

  return {
    async createChildWorktree(input) {
      const label = safeWorktreeLabel(input.childSessionId);
      const parentCwd = resolve(input.parentCwd);
      const baseDir = resolve(options.baseDir ?? join(dirname(parentCwd), `${basename(parentCwd)}-worktrees`));
      const path = join(baseDir, label);
      mkdirSync(baseDir, { recursive: true });

      const result = runGit({
        cwd: parentCwd,
        args: ["worktree", "add", "--detach", path, "HEAD"],
      });
      if (result.status !== 0) {
        throw new Error(`Failed to create child worktree: ${sanitizeGitDiagnostic(result.stderr ?? "")}`);
      }

      return { path, label };
    },
  };
}

export type WorktreeAttestor = (worktreePath: string) => string[];

/**
 * Authoritative changed-file evidence: reads the worker worktree's git status
 * instead of trusting the child's self-reported file list.
 */
export function attestWorktreeFiles(worktreePath: string): string[] {
  // -uall lists untracked files individually instead of collapsing new
  // directories, so attested paths compare cleanly with claimed paths.
  const result = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: worktreePath,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 3)
    .map((line) => line.slice(2).trim().replace(/^"|"$/g, ""))
    .filter((path) => path.length > 0);
}

function defaultGitRunner(input: { cwd: string; args: string[] }): { status: number | null; stderr?: string } {
  const result = spawnSync("git", input.args, {
    cwd: input.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stderr: result.stderr };
}

function safeWorktreeLabel(childSessionId: string): string {
  return `child-${childSessionId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

function sanitizeGitDiagnostic(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : "git worktree add exited unsuccessfully";
}
