import { spawnSync } from "node:child_process";

import type { AgentRuntimeWorktreeMetadata } from "../../domain/index.js";
import type { WorktreeService } from "./worktree-service.js";

export type IntegrationVerificationFailure =
  | "git_failure"
  | "head_moved"
  | "unresolved"
  | "empty"
  | "scope_violation"
  | "candidate_failed";

export type IntegrationPreparationResult =
  | { ok: true; worktree: AgentRuntimeWorktreeMetadata; conflictFiles: string[]; allowedFiles: string[] }
  | { ok: false; status: "git_failure" | "conflict_missing"; safeSummary: string };

export type IntegrationCandidateResult =
  | { ok: true; resolvedCandidateCommitSha: string; changedFiles: string[]; safeSummary: string }
  | { ok: false; status: IntegrationVerificationFailure; safeSummary: string };

export interface ManagedIntegrationService {
  prepare(input: {
    supervisorCwd: string;
    integrationAttemptId: string;
    checkpointHead: string;
    originalCandidateCommitSha: string;
    candidateFiles: string[];
  }): Promise<IntegrationPreparationResult>;
  verifyAndCreateCandidate(input: {
    integrationCwd: string;
    checkpointHead: string;
    allowedFiles: string[];
    safeSummary: string;
  }): IntegrationCandidateResult;
  cleanup(input: { supervisorCwd: string; integrationCwd: string }): Promise<void>;
}

export interface ManagedIntegrationServiceOptions {
  worktreeService: WorktreeService;
  runGit?: GitRunner;
}

type GitRunner = (input: { cwd: string; args: string[] }) => GitResult;
interface GitResult { status: number | null; stdout: string; stderr: string }

export function createManagedIntegrationService(options: ManagedIntegrationServiceOptions): ManagedIntegrationService {
  const runGit = options.runGit ?? defaultGitRunner;
  return {
    async prepare(input) {
      if (!options.worktreeService.createIntegrationWorktree) {
        return { ok: false, status: "git_failure", safeSummary: "Integration worktree support is unavailable." };
      }
      const supervisorHead = runGit({ cwd: input.supervisorCwd, args: ["rev-parse", "HEAD"] });
      const supervisorStatus = runGit({ cwd: input.supervisorCwd, args: ["status", "--porcelain", "-uall"] });
      if (supervisorHead.status !== 0 || supervisorStatus.status !== 0 ||
          normalize(supervisorHead.stdout) !== input.checkpointHead || normalize(supervisorStatus.stdout)) {
        return { ok: false, status: "git_failure", safeSummary: "Supervisor checkpoint is not clean for integration recovery." };
      }
      let worktree: AgentRuntimeWorktreeMetadata;
      try {
        worktree = await options.worktreeService.createIntegrationWorktree({
          parentCwd: input.supervisorCwd,
          integrationAttemptId: input.integrationAttemptId,
          checkpointHead: input.checkpointHead,
        });
      } catch (error) {
        return { ok: false, status: "git_failure", safeSummary: safeError(error) };
      }
      const apply = runGit({ cwd: worktree.path, args: ["cherry-pick", "--no-commit", input.originalCandidateCommitSha] });
      if (apply.status === 0) {
        await options.worktreeService.removeWorktree?.({ parentCwd: input.supervisorCwd, path: worktree.path });
        return { ok: false, status: "conflict_missing", safeSummary: "Candidate no longer conflicts at the recorded checkpoint." };
      }
      const conflicts = nameOnly(runGit, worktree.path, ["diff", "--name-only", "--diff-filter=U"]);
      if (!conflicts.ok || conflicts.files.length === 0) {
        await options.worktreeService.removeWorktree?.({ parentCwd: input.supervisorCwd, path: worktree.path });
        return { ok: false, status: "git_failure", safeSummary: "Backend could not reproduce the recorded candidate conflict." };
      }
      return {
        ok: true,
        worktree,
        conflictFiles: conflicts.files,
        allowedFiles: uniqueSorted([...input.candidateFiles, ...conflicts.files]),
      };
    },
    verifyAndCreateCandidate(input) {
      const head = runGit({ cwd: input.integrationCwd, args: ["rev-parse", "HEAD"] });
      if (head.status !== 0) return failure("git_failure", "Unable to verify integration worktree HEAD.");
      if (normalize(head.stdout) !== input.checkpointHead) {
        return failure("head_moved", "Integrator moved HEAD; LLM-created commits are not deliverable.");
      }
      const unresolved = nameOnly(runGit, input.integrationCwd, ["diff", "--name-only", "--diff-filter=U"]);
      if (!unresolved.ok) return failure("git_failure", "Unable to inspect integration conflict state.");
      if (unresolved.files.length > 0) {
        return failure("unresolved", "Integration worktree still has unresolved index entries.");
      }
      const changed = changedFiles(runGit, input.integrationCwd);
      if (!changed.ok) return failure("git_failure", "Unable to attest integration worktree changes.");
      if (changed.files.length === 0) return failure("empty", "Integration produced no deliverable changes.");
      const allowed = new Set(uniqueSorted(input.allowedFiles));
      const outside = changed.files.filter((file) => !allowed.has(file));
      if (outside.length > 0) {
        return failure("scope_violation", `Integration changed files outside the allowed scope: ${outside.join(", ").slice(0, 300)}`);
      }
      const add = runGit({ cwd: input.integrationCwd, args: ["add", "--", ...changed.files] });
      if (add.status !== 0) return failure("candidate_failed", "Backend could not stage the verified integration changes.");
      const commit = runGit({
        cwd: input.integrationCwd,
        args: ["-c", "user.name=Auto Agent Runtime", "-c", "user.email=runtime@auto-agent.invalid",
          "commit", "-m", `auto-agent resolved candidate: ${input.safeSummary.slice(0, 120)}`],
      });
      if (commit.status !== 0) return failure("candidate_failed", `Backend could not create the resolved candidate: ${safe(commit.stderr)}`);
      const resolved = runGit({ cwd: input.integrationCwd, args: ["rev-parse", "HEAD"] });
      const finalStatus = runGit({ cwd: input.integrationCwd, args: ["status", "--porcelain", "-uall"] });
      if (resolved.status !== 0 || finalStatus.status !== 0 || normalize(finalStatus.stdout)) {
        return failure("candidate_failed", "Resolved candidate state could not be verified.");
      }
      return {
        ok: true,
        resolvedCandidateCommitSha: normalize(resolved.stdout),
        changedFiles: changed.files,
        safeSummary: "Backend created and verified the resolved integration candidate.",
      };
    },
    async cleanup(input) {
      if (options.worktreeService.removeWorktree) {
        await options.worktreeService.removeWorktree({ parentCwd: input.supervisorCwd, path: input.integrationCwd });
      }
    },
  };
}

function failure(status: IntegrationVerificationFailure, safeSummary: string): IntegrationCandidateResult {
  return { ok: false, status, safeSummary };
}

function changedFiles(runGit: GitRunner, cwd: string): { ok: true; files: string[] } | { ok: false } {
  const result = runGit({ cwd, args: ["status", "--porcelain", "-uall"] });
  if (result.status !== 0) return { ok: false };
  return {
    ok: true,
    files: String(result.stdout ?? "").split(/\r?\n/).filter((line) => line.length >= 4)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, "")).filter(Boolean).sort(),
  };
}

function nameOnly(runGit: GitRunner, cwd: string, args: string[]): { ok: true; files: string[] } | { ok: false } {
  const result = runGit({ cwd, args });
  if (result.status !== 0) return { ok: false };
  return { ok: true, files: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort() };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function defaultGitRunner(input: { cwd: string; args: string[] }): GitResult {
  const result = spawnSync("git", input.args, { cwd: input.cwd, encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safe(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function safeError(error: unknown): string {
  return error instanceof Error ? safe(error.message) : "Integration worktree creation failed.";
}
