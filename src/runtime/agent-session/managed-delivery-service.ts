import { spawnSync } from "node:child_process";

import type { ManagedDeliveryOutcome } from "../../domain/index.js";

export interface ManagedDeliveryInput {
  workerCwd: string;
  supervisorCwd: string;
  attestedFiles: string[];
  safeSummary: string;
}

export interface ManagedCandidateDeliveryInput {
  supervisorCwd: string;
  checkpointHead: string;
  candidateCommitSha: string;
  safeSummary: string;
}

export interface ManagedDeliveryResult {
  status: ManagedDeliveryOutcome;
  safeSummary: string;
  checkpointHead: string | null;
  checkpointStatus: string | null;
  candidateCommitSha: string | null;
  commitSha: string | null;
  validationCommand: string | null;
  validationExitCode: number | null;
  validationSummary: string | null;
  rollbackSummary: string | null;
  candidateFiles?: string[];
  conflictFiles?: string[];
  conflictSummary?: string | null;
}

export interface ManagedDeliveryServiceOptions {
  fixedValidationCommand?: string;
  runGit?: GitRunner;
  runCommand?: CommandRunner;
}

export type GitRunner = (input: { cwd: string; args: string[] }) => CommandResult;
export type CommandRunner = (input: { cwd: string; command: string }) => CommandResult;
export interface CommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ManagedDeliveryService {
  deliver(input: ManagedDeliveryInput): ManagedDeliveryResult;
  deliverCandidate?(input: ManagedCandidateDeliveryInput): ManagedDeliveryResult;
}

export function createManagedDeliveryService(options: ManagedDeliveryServiceOptions = {}): ManagedDeliveryService {
  const runGit = options.runGit ?? defaultGitRunner;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const fixedValidationCommand = options.fixedValidationCommand ??
    process.env.AUTO_AGENT_REVIEW_MERGE_TEST_COMMAND ?? "npm test";

  return {
    deliver(input) {
      const currentFiles = changedFiles(runGit, input.workerCwd);
      if (!currentFiles.ok) {
        return outcome("verification_failed", "Unable to attest the worker worktree before delivery.");
      }
      const expected = [...new Set(input.attestedFiles)].sort();
      if (!sameStrings(currentFiles.files, expected)) {
        return outcome("verification_failed", "Worker worktree changed after its persisted attestation.");
      }
      if (expected.length === 0) {
        return outcome("rejected", "Delivery requested without attested workspace changes.");
      }

      const supervisorStatus = runGit({ cwd: input.supervisorCwd, args: ["status", "--porcelain", "-uall"] });
      if (supervisorStatus.status !== 0) {
        return outcome("verification_failed", `Unable to verify supervisor workspace: ${safe(supervisorStatus.stderr)}`);
      }
      if (safe(supervisorStatus.stdout).length > 0) {
        return outcome("verification_failed", `Supervisor workspace is dirty: ${safe(supervisorStatus.stdout)}`);
      }
      const checkpointResult = runGit({ cwd: input.supervisorCwd, args: ["rev-parse", "HEAD"] });
      if (checkpointResult.status !== 0) {
        return outcome("verification_failed", "Unable to record the clean supervisor checkpoint.");
      }
      const checkpointHead = safe(checkpointResult.stdout);

      const add = runGit({ cwd: input.workerCwd, args: ["add", "--", ...expected] });
      if (add.status !== 0) {
        return withCheckpoint(outcome("failed", `Unable to stage attested worker changes: ${safe(add.stderr)}`), checkpointHead);
      }
      const commit = runGit({
        cwd: input.workerCwd,
        args: [
          "-c", "user.name=Auto Agent Runtime", "-c", "user.email=runtime@auto-agent.invalid",
          "commit", "-m", `auto-agent candidate: ${input.safeSummary.slice(0, 120)}`,
        ],
      });
      if (commit.status !== 0) {
        return withCheckpoint(outcome("failed", `Unable to create runtime candidate commit: ${safe(commit.stderr)}`), checkpointHead);
      }
      const candidateResult = runGit({ cwd: input.workerCwd, args: ["rev-parse", "HEAD"] });
      if (candidateResult.status !== 0) {
        return withCheckpoint(outcome("verification_failed", "Candidate commit could not be verified."), checkpointHead);
      }
      const candidateCommitSha = safe(candidateResult.stdout);

      const apply = runGit({ cwd: input.supervisorCwd, args: ["cherry-pick", candidateCommitSha] });
      if (apply.status !== 0) {
        const conflicts = nameOnly(runGit, input.supervisorCwd, ["diff", "--name-only", "--diff-filter=U"]);
        const restored = restoreCheckpoint(runGit, input.supervisorCwd, checkpointHead, true);
        return {
          ...withCheckpoint(outcome(restored.ok ? "conflict" : "revert_failed", restored.ok
            ? "Candidate commit conflicted; the supervisor checkpoint was restored."
            : "Candidate commit conflicted and the supervisor checkpoint could not be restored."), checkpointHead),
          candidateCommitSha,
          candidateFiles: expected,
          conflictFiles: conflicts,
          conflictSummary: safe(apply.stderr) || "Candidate apply reported a conflict.",
          rollbackSummary: restored.summary,
        };
      }

      const validation = runCommand({ cwd: input.supervisorCwd, command: fixedValidationCommand });
      const validationSummary = safe(`${validation.stdout ?? ""} ${validation.stderr ?? ""}`);
      if (validation.status !== 0) {
        const restored = restoreCheckpoint(runGit, input.supervisorCwd, checkpointHead, false);
        return {
          ...withCheckpoint(outcome(
            restored.ok ? (validation.status === null ? "verification_failed" : "test_failed_reverted") : "revert_failed",
            restored.ok
              ? "Fixed validation failed; the supervisor checkpoint was restored and verified."
              : "Fixed validation failed and rollback could not be verified.",
          ), checkpointHead),
          candidateCommitSha,
          validationCommand: fixedValidationCommand,
          validationExitCode: validation.status,
          validationSummary,
          rollbackSummary: restored.summary,
        };
      }

      const deliveredHead = runGit({ cwd: input.supervisorCwd, args: ["rev-parse", "HEAD"] });
      const finalStatus = runGit({ cwd: input.supervisorCwd, args: ["status", "--porcelain", "-uall"] });
      if (deliveredHead.status !== 0 || finalStatus.status !== 0 || safe(finalStatus.stdout).length > 0) {
        const restored = restoreCheckpoint(runGit, input.supervisorCwd, checkpointHead, false);
        return {
          ...withCheckpoint(outcome(restored.ok ? "verification_failed" : "revert_failed",
            "Delivered workspace state could not be verified."), checkpointHead),
          candidateCommitSha,
          validationCommand: fixedValidationCommand,
          validationExitCode: validation.status,
          validationSummary,
          rollbackSummary: restored.summary,
        };
      }
      return {
        status: "committed",
        safeSummary: "Candidate applied and fixed validation passed under backend authority.",
        checkpointHead,
        checkpointStatus: "clean",
        candidateCommitSha,
        commitSha: safe(deliveredHead.stdout),
        validationCommand: fixedValidationCommand,
        validationExitCode: validation.status,
        validationSummary,
        rollbackSummary: null,
        candidateFiles: expected,
        conflictFiles: [],
        conflictSummary: null,
      };
    },
    deliverCandidate(input) {
      const status = runGit({ cwd: input.supervisorCwd, args: ["status", "--porcelain", "-uall"] });
      const head = runGit({ cwd: input.supervisorCwd, args: ["rev-parse", "HEAD"] });
      if (status.status !== 0 || head.status !== 0 || safe(status.stdout) || safe(head.stdout) !== input.checkpointHead) {
        return withCheckpoint(outcome("verification_failed", "Supervisor checkpoint changed before resolved delivery."), input.checkpointHead);
      }
      const candidateFiles = nameOnly(runGit, input.supervisorCwd,
        ["diff-tree", "--no-commit-id", "--name-only", "-r", input.candidateCommitSha]);
      const apply = runGit({ cwd: input.supervisorCwd, args: ["cherry-pick", input.candidateCommitSha] });
      if (apply.status !== 0) {
        const conflictFiles = nameOnly(runGit, input.supervisorCwd, ["diff", "--name-only", "--diff-filter=U"]);
        const restored = restoreCheckpoint(runGit, input.supervisorCwd, input.checkpointHead, true);
        return {
          ...withCheckpoint(outcome(restored.ok ? "conflict" : "revert_failed", restored.ok
            ? "Resolved candidate conflicted again; the supervisor checkpoint was restored."
            : "Resolved candidate conflicted again and rollback could not be verified."), input.checkpointHead),
          candidateCommitSha: input.candidateCommitSha,
          candidateFiles,
          conflictFiles,
          conflictSummary: safe(apply.stderr) || "Resolved candidate apply reported a conflict.",
          rollbackSummary: restored.summary,
        };
      }
      const validation = runCommand({ cwd: input.supervisorCwd, command: fixedValidationCommand });
      const validationSummary = safe(`${validation.stdout ?? ""} ${validation.stderr ?? ""}`);
      if (validation.status !== 0) {
        const restored = restoreCheckpoint(runGit, input.supervisorCwd, input.checkpointHead, false);
        return {
          ...withCheckpoint(outcome(
            restored.ok ? (validation.status === null ? "verification_failed" : "test_failed_reverted") : "revert_failed",
            restored.ok ? "Fixed validation failed; the supervisor checkpoint was restored and verified."
              : "Fixed validation failed and rollback could not be verified.",
          ), input.checkpointHead),
          candidateCommitSha: input.candidateCommitSha,
          candidateFiles,
          validationCommand: fixedValidationCommand,
          validationExitCode: validation.status,
          validationSummary,
          rollbackSummary: restored.summary,
        };
      }
      const deliveredHead = runGit({ cwd: input.supervisorCwd, args: ["rev-parse", "HEAD"] });
      const finalStatus = runGit({ cwd: input.supervisorCwd, args: ["status", "--porcelain", "-uall"] });
      if (deliveredHead.status !== 0 || finalStatus.status !== 0 || safe(finalStatus.stdout)) {
        const restored = restoreCheckpoint(runGit, input.supervisorCwd, input.checkpointHead, false);
        return {
          ...withCheckpoint(outcome(restored.ok ? "verification_failed" : "revert_failed",
            "Resolved delivery workspace state could not be verified."), input.checkpointHead),
          candidateCommitSha: input.candidateCommitSha,
          candidateFiles,
          validationCommand: fixedValidationCommand,
          validationExitCode: validation.status,
          validationSummary,
          rollbackSummary: restored.summary,
        };
      }
      return {
        status: "committed",
        safeSummary: "Resolved candidate applied and fixed validation passed under backend authority.",
        checkpointHead: input.checkpointHead,
        checkpointStatus: "clean",
        candidateCommitSha: input.candidateCommitSha,
        commitSha: safe(deliveredHead.stdout),
        validationCommand: fixedValidationCommand,
        validationExitCode: validation.status,
        validationSummary,
        rollbackSummary: null,
        candidateFiles,
        conflictFiles: [],
        conflictSummary: null,
      };
    },
  };
}

function changedFiles(runGit: GitRunner, cwd: string): { ok: true; files: string[] } | { ok: false } {
  const result = runGit({ cwd, args: ["status", "--porcelain", "-uall"] });
  if (result.status !== 0) return { ok: false };
  return {
    ok: true,
    files: String(result.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.length >= 4)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
      .sort(),
  };
}

function restoreCheckpoint(runGit: GitRunner, cwd: string, checkpoint: string, abortCherryPick: boolean): { ok: boolean; summary: string } {
  if (abortCherryPick) runGit({ cwd, args: ["cherry-pick", "--abort"] });
  const reset = runGit({ cwd, args: ["reset", "--hard", checkpoint] });
  const clean = runGit({ cwd, args: ["clean", "-fd"] });
  const head = runGit({ cwd, args: ["rev-parse", "HEAD"] });
  const status = runGit({ cwd, args: ["status", "--porcelain", "-uall"] });
  const ok = reset.status === 0 && clean.status === 0 && head.status === 0 && status.status === 0 &&
    safe(head.stdout) === checkpoint && safe(status.stdout).length === 0;
  return {
    ok,
    summary: ok ? "Supervisor workspace restored to its clean checkpoint." :
      `Rollback verification failed: ${safe(`${reset.stderr ?? ""} ${clean.stderr ?? ""} ${head.stderr ?? ""} ${status.stderr ?? ""}`)}`,
  };
}

function outcome(status: ManagedDeliveryOutcome, safeSummary: string): ManagedDeliveryResult {
  return {
    status, safeSummary, checkpointHead: null, checkpointStatus: null, candidateCommitSha: null,
    commitSha: null, validationCommand: null, validationExitCode: null, validationSummary: null, rollbackSummary: null,
    candidateFiles: [], conflictFiles: [], conflictSummary: null,
  };
}

function nameOnly(runGit: GitRunner, cwd: string, args: string[]): string[] {
  const result = runGit({ cwd, args });
  if (result.status !== 0) return [];
  return String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}

function withCheckpoint(result: ManagedDeliveryResult, checkpointHead: string): ManagedDeliveryResult {
  return { ...result, checkpointHead, checkpointStatus: "clean" };
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function defaultGitRunner(input: { cwd: string; args: string[] }): CommandResult {
  const result = spawnSync("git", input.args, { cwd: input.cwd, encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function defaultCommandRunner(input: { cwd: string; command: string }): CommandResult {
  const result = spawnSync(input.command, { cwd: input.cwd, encoding: "utf8", shell: true, windowsHide: true });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function safe(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
