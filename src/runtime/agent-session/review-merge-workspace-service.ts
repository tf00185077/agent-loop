import { spawnSync } from "node:child_process";

import type { AgentRuntimeReviewMergeCheckpoint } from "../../domain/index.js";

export interface ReviewMergeWorkspaceService {
  prepareReviewMerge(cwd: string): Promise<ReviewMergePrepareResult>;
}

export type ReviewMergePrepareResult =
  | { ok: true; checkpoint: AgentRuntimeReviewMergeCheckpoint }
  | { ok: false; safeReason: string };

export interface ReviewMergeWorkspaceServiceOptions {
  runGit?: GitRunner;
}

export type GitRunner = (input: { cwd: string; args: string[] }) => { status: number | null; stdout?: string; stderr?: string };

export function createGitReviewMergeWorkspaceService(
  options: ReviewMergeWorkspaceServiceOptions = {},
): ReviewMergeWorkspaceService {
  const runGit = options.runGit ?? defaultGitRunner;

  return {
    async prepareReviewMerge(cwd) {
      const status = runGit({ cwd, args: ["status", "--porcelain"] });
      if (status.status !== 0) {
        return { ok: false, safeReason: `Unable to verify supervisor workspace cleanliness: ${safeGitSummary(status.stderr)}` };
      }
      const statusSummary = safeGitSummary(status.stdout);
      if (statusSummary.length > 0) {
        return { ok: false, safeReason: `Supervisor workspace is dirty: ${statusSummary}` };
      }

      const head = runGit({ cwd, args: ["rev-parse", "HEAD"] });
      if (head.status !== 0) {
        return { ok: false, safeReason: `Unable to record pre-merge checkpoint: ${safeGitSummary(head.stderr)}` };
      }

      return {
        ok: true,
        checkpoint: {
          head: safeGitSummary(head.stdout),
          statusSummary: "clean",
        },
      };
    },
  };
}

function defaultGitRunner(input: { cwd: string; args: string[] }) {
  const result = spawnSync("git", input.args, {
    cwd: input.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function safeGitSummary(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
