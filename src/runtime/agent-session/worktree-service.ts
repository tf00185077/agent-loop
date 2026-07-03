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
