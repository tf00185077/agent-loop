import { spawnSync } from "node:child_process";

import type { AgentRuntimeReviewMergeCheckpoint } from "../../domain/index.js";

export interface ReviewMergeVerificationService {
  verifyMerged(input: VerifyMergedInput): ReviewMergeVerificationResult;
}

export interface VerifyMergedInput {
  cwd: string;
  checkpoint: AgentRuntimeReviewMergeCheckpoint;
}

export interface ReviewMergeVerificationResult {
  outcome:
    | "merged"
    | "test_failed_reverted"
    | "revert_failed"
    | "failed"
    | "verification_failed";
  fixedTest: {
    command: string;
    exitCode: number | null;
    outputSummary: string;
  };
  revertEvidence?: {
    verified: boolean;
    summary: string;
  } | null;
  safeSummary: string;
}

export interface ReviewMergeVerificationServiceOptions {
  fixedTestCommand?: string;
  runCommand?: CommandRunner;
  runGit?: GitRunner;
}

export type CommandRunner = (input: { cwd: string; command: string }) => { status: number | null; output?: string };
export type GitRunner = (input: { cwd: string; args: string[] }) => { status: number | null; stdout?: string; stderr?: string };

export function createReviewMergeVerificationService(
  options: ReviewMergeVerificationServiceOptions = {},
): ReviewMergeVerificationService {
  const fixedTestCommand = options.fixedTestCommand ?? process.env.AUTO_AGENT_REVIEW_MERGE_TEST_COMMAND ?? "npm test";
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const runGit = options.runGit ?? defaultGitRunner;

  return {
    verifyMerged(input) {
      const test = runCommand({ cwd: input.cwd, command: fixedTestCommand });
      const fixedTest = {
        command: fixedTestCommand,
        exitCode: test.status,
        outputSummary: safeSummary(test.output),
      };
      if (test.status === 0) {
        return {
          outcome: "merged",
          fixedTest,
          revertEvidence: null,
          safeSummary: "Fixed review-merge test command passed.",
        };
      }
      if (test.status === null) {
        return {
          outcome: "verification_failed",
          fixedTest,
          revertEvidence: null,
          safeSummary: "Fixed review-merge test command could not be verified.",
        };
      }

      const reset = runGit({ cwd: input.cwd, args: ["reset", "--hard", input.checkpoint.head] });
      const clean = runGit({ cwd: input.cwd, args: ["clean", "-fd"] });
      const status = runGit({ cwd: input.cwd, args: ["status", "--porcelain"] });
      const head = runGit({ cwd: input.cwd, args: ["rev-parse", "HEAD"] });
      const reverted =
        reset.status === 0 &&
        clean.status === 0 &&
        status.status === 0 &&
        safeSummary(status.stdout).length === 0 &&
        head.status === 0 &&
        safeSummary(head.stdout) === input.checkpoint.head;

      return {
        outcome: reverted ? "test_failed_reverted" : "revert_failed",
        fixedTest,
        revertEvidence: {
          verified: reverted,
          summary: reverted
            ? "Workspace reverted to pre-merge checkpoint."
            : safeSummary(`${reset.stderr ?? ""} ${clean.stderr ?? ""} ${status.stdout ?? ""} ${head.stdout ?? ""}`),
        },
        safeSummary: reverted
          ? "Fixed review-merge test failed; workspace revert verified."
          : "Fixed review-merge test failed; workspace revert could not be verified.",
      };
    },
  };
}

function defaultCommandRunner(input: { cwd: string; command: string }) {
  const result = spawnSync(input.command, {
    cwd: input.cwd,
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function defaultGitRunner(input: { cwd: string; args: string[] }) {
  const result = spawnSync("git", input.args, {
    cwd: input.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function safeSummary(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
