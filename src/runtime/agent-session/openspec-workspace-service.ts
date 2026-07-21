import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { ManagedChangePlanEntry } from "../../domain/index.js";
import { isWorkspaceStatusClean } from "./workspace-cleanliness.js";
import { detectCliCommand } from "../cli/cli-command-detection.js";
import {
  computeArchiveManifestDigest,
  proveArchiveManifestIdentity,
} from "./archive-manifest.js";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface OpenSpecWorkspaceServiceOptions {
  /** Returns the OpenSpec CLI command path, or null when unavailable. */
  detectCli?: () => string | null;
  /** Runs the OpenSpec CLI with args in a cwd. Injectable for tests. */
  runCli?: (args: string[], cwd: string) => CommandResult;
  /** Runs git with args in a cwd. Injectable for tests. */
  runGit?: (args: string[], cwd: string) => CommandResult;
}

export interface ScaffoldChangeInput {
  cwd: string;
  change: ManagedChangePlanEntry;
}

export interface ScaffoldChangeResult {
  ok: boolean;
  safeReason?: string;
  committed: boolean;
}

export interface ValidateChangeInput {
  cwd: string;
  changeId: string;
}

export interface ValidateChangeResult {
  ok: boolean;
  failures: string[];
}

export interface ArchiveChangeInput {
  cwd: string;
  changeId: string;
  date: string;
  ignoredWorkspacePaths?: string[];
  sourcePath?: string;
  targetPath?: string;
  manifestDigest?: string;
  preArchiveHead?: string;
  /** Previously finalized archive commit; terminal replay verifies it remains an ancestor. */
  archiveCommitSha?: string;
}

export interface ArchiveChangeResult {
  ok: boolean;
  safeReason?: string;
  targetPath?: string;
  manifestDigest?: string;
  archiveCommitSha?: string;
  idempotent?: boolean;
}

export interface PrepareArchiveResultSuccess {
  ok: true;
  sourcePath: string;
  targetPath: string;
  manifestDigest: string;
  preArchiveHead: string;
}

export type PrepareArchiveResult = PrepareArchiveResultSuccess | { ok: false; safeReason: string };

export interface OpenSpecWorkspaceService {
  mode(): "cli" | "degraded";
  scaffoldChange(input: ScaffoldChangeInput): ScaffoldChangeResult;
  validateChange(input: ValidateChangeInput): ValidateChangeResult;
  prepareArchive?(input: ArchiveChangeInput): PrepareArchiveResult;
  archiveChange(input: ArchiveChangeInput): ArchiveChangeResult;
}

/**
 * Backend-owned OpenSpec operations for goal workspaces: scaffold change
 * artifacts from internal templates, validate structurally (with the OpenSpec
 * CLI as an additional strict gate when detected), and archive by dated move.
 * Agents never run the CLI; this service is the deterministic side of the
 * change-plan flow.
 */
export function createOpenSpecWorkspaceService(
  options: OpenSpecWorkspaceServiceOptions = {},
): OpenSpecWorkspaceService {
  const detect = options.detectCli ?? defaultDetectOpenSpecCli;
  const runCli = options.runCli ?? defaultRunCommand;
  const runGit = options.runGit ?? defaultRunGit;
  let cliPath: string | null | undefined;

  function cli(): string | null {
    if (cliPath === undefined) {
      cliPath = detect();
    }
    return cliPath;
  }

  return {
    mode() {
      return cli() ? "cli" : "degraded";
    },

    scaffoldChange(input) {
      const changeDir = join(input.cwd, "openspec", "changes", input.change.id);
      try {
        mkdirSync(join(changeDir, "specs"), { recursive: true });
        writeFileSync(join(changeDir, "proposal.md"), renderProposalTemplate(input.change), "utf8");
        writeFileSync(join(changeDir, "tasks.md"), renderTasksTemplate(input.change), "utf8");
      } catch (err) {
        return {
          ok: false,
          committed: false,
          safeReason: `Could not scaffold change ${input.change.id}: ${message(err)}`,
        };
      }

      const added = runGit(["add", join("openspec", "changes", input.change.id)], input.cwd);
      if (added.status !== 0) {
        // Not a git workspace (or add failed): scaffolding still exists, but
        // child worktrees will not see it. Callers surface this durably.
        return { ok: true, committed: false, safeReason: trimmedOutput(added) || "git add failed" };
      }
      const committed = runGit(
        ["commit", "-m", `openspec: scaffold ${input.change.id}`, "--no-verify"],
        input.cwd,
      );
      if (committed.status !== 0) {
        return { ok: true, committed: false, safeReason: trimmedOutput(committed) || "git commit failed" };
      }
      return { ok: true, committed: true };
    },

    validateChange(input) {
      const failures = structuralChecks(input.cwd, input.changeId);
      const command = cli();
      if (command) {
        const result = runCli(["validate", input.changeId, "--strict"], input.cwd);
        if (result.status !== 0) {
          failures.push(
            `openspec validate --strict failed: ${trimmedOutput(result) || `exit ${result.status ?? "unknown"}`}`,
          );
        }
      }
      return { ok: failures.length === 0, failures };
    },

    prepareArchive(input) {
      try {
        return prepareArchiveIdentity(input, runGit);
      } catch (err) {
        return { ok: false, safeReason: `Could not prepare archive ${input.changeId}: ${message(err)}` };
      }
    },

    archiveChange(input) {
      try {
        const identity = input.sourcePath && input.targetPath && input.manifestDigest && input.preArchiveHead
          ? {
              ok: true as const,
              sourcePath: input.sourcePath,
              targetPath: input.targetPath,
              manifestDigest: input.manifestDigest,
              preArchiveHead: input.preArchiveHead,
            }
          : prepareArchiveIdentity(input, runGit);
        if (!identity.ok) return identity;
        const expectedSource = resolve(input.cwd, "openspec", "changes", input.changeId);
        const expectedTarget = resolve(input.cwd, "openspec", "changes", "archive", `${input.date}-${input.changeId}`);
        if (resolve(identity.sourcePath) !== expectedSource || resolve(identity.targetPath) !== expectedTarget) {
          return { ok: false, safeReason: "Archive identity paths do not match the selected Goal change." };
        }
        const matches = matchingArchivePaths(input.cwd, input.changeId);
        const sourceExists = existsSync(identity.sourcePath);
        const targetExists = existsSync(identity.targetPath);
        if (matches.some((path) => resolve(path) !== resolve(identity.targetPath))) {
          return { ok: false, safeReason: `Archive state is ambiguous for ${input.changeId}: multiple dated targets exist.` };
        }
        if (sourceExists === targetExists) {
          return {
            ok: false,
            safeReason: `Archive state is ambiguous for ${input.changeId}: source and target are ${sourceExists ? "both present" : "both absent"}.`,
          };
        }
        const manifestPath = sourceExists ? identity.sourcePath : identity.targetPath;
        if (computeArchiveManifestDigest(manifestPath) !== identity.manifestDigest) {
          return { ok: false, safeReason: `Archive manifest digest mismatch for ${input.changeId}.` };
        }
        const sourceRelative = gitRelativePath(input.cwd, identity.sourcePath);
        const targetRelative = gitRelativePath(input.cwd, identity.targetPath);
        let idempotent = !sourceExists && targetExists;
        if (sourceExists) {
          const clean = requireCleanGitWorkspace(runGit, input.cwd, input.changeId, input.ignoredWorkspacePaths ?? []);
          if (!clean.ok) return clean;
          const head = runGit(["rev-parse", "HEAD"], input.cwd);
          if (head.status !== 0 || head.stdout.trim() !== identity.preArchiveHead) {
            return { ok: false, safeReason: `Archive workspace HEAD changed for ${input.changeId}.` };
          }
          mkdirSync(join(input.cwd, "openspec", "changes", "archive"), { recursive: true });
          renameSync(identity.sourcePath, identity.targetPath);
          idempotent = false;
        }
        const status = runGit(["status", "--porcelain", "-uall"], input.cwd);
        if (status.status !== 0) {
          return { ok: false, safeReason: `Could not inspect archive Git state: ${trimmedOutput(status)}` };
        }
        if (status.stdout.trim()) {
          const scoped = changedGitPaths(runGit, input.cwd, input.ignoredWorkspacePaths ?? []);
          if (!scoped.ok) return scoped;
          if (scoped.paths.length === 0 || scoped.paths.some((path) =>
            !isWithinGitPath(path, sourceRelative) && !isWithinGitPath(path, targetRelative)
          )) {
            return { ok: false, safeReason: `Archive workspace contains unrelated changes for ${input.changeId}.` };
          }
          if (computeArchiveManifestDigest(identity.targetPath) !== identity.manifestDigest) {
            return { ok: false, safeReason: `Archive manifest digest mismatch for ${input.changeId}.` };
          }
          const added = runGit(["add", "-A", "--", sourceRelative, targetRelative], input.cwd);
          if (added.status !== 0) return { ok: false, safeReason: `Could not stage archive: ${trimmedOutput(added)}` };
          if (computeArchiveManifestDigest(identity.targetPath) !== identity.manifestDigest) {
            return { ok: false, safeReason: `Archive manifest digest mismatch for ${input.changeId}.` };
          }
          const committed = runGit(
            ["commit", "--only", "-m", `openspec: archive ${input.changeId}`, "--no-verify", "--", sourceRelative, targetRelative],
            input.cwd,
          );
          if (committed.status !== 0) return { ok: false, safeReason: `Could not commit archive: ${trimmedOutput(committed)}` };
        }
        const proof = proveUniqueArchiveCommit({
          runGit,
          cwd: input.cwd,
          preArchiveHead: identity.preArchiveHead,
          sourceRelative,
          targetRelative,
        });
        if (!proof.ok) return proof;
        if (input.archiveCommitSha && proof.archiveCommitSha !== input.archiveCommitSha) {
          return { ok: false, safeReason: `Recorded archive commit does not match the unique verified archive for ${input.changeId}.` };
        }
        const manifestProof = proveArchiveManifestIdentity({
          cwd: input.cwd,
          targetPath: identity.targetPath,
          targetRelative,
          archiveCommitSha: proof.archiveCommitSha,
          expectedDigest: identity.manifestDigest,
        });
        if (!manifestProof.ok) {
          return { ok: false, safeReason: `Archive manifest digest mismatch for ${input.changeId}.` };
        }
        return {
          ok: true,
          targetPath: identity.targetPath,
          manifestDigest: identity.manifestDigest,
          archiveCommitSha: proof.archiveCommitSha,
          idempotent,
        };
      } catch (err) {
        return { ok: false, safeReason: `Archive operation failed for ${input.changeId}: ${message(err)}` };
      }
    },
  };
}

function prepareArchiveIdentity(
  input: ArchiveChangeInput,
  runGit: (args: string[], cwd: string) => CommandResult,
): PrepareArchiveResult {
  const sourcePath = resolve(input.cwd, "openspec", "changes", input.changeId);
  const targetPath = resolve(input.cwd, "openspec", "changes", "archive", `${input.date}-${input.changeId}`);
  const sourceExists = existsSync(sourcePath);
  const targetExists = existsSync(targetPath);
  const matches = matchingArchivePaths(input.cwd, input.changeId);
  if (!sourceExists || targetExists || matches.length > 0) {
    return {
      ok: false,
      safeReason:
        `Archive state is ambiguous for ${input.changeId}: expected one active source and no dated target ` +
        `(source=${sourceExists}, target=${targetExists}, matches=${matches.length}).`,
    };
  }
  const head = runGit(["rev-parse", "HEAD"], input.cwd);
  if (head.status !== 0 || !head.stdout.trim()) {
    return { ok: false, safeReason: `Could not record pre-archive workspace HEAD: ${trimmedOutput(head)}` };
  }
  const clean = requireCleanGitWorkspace(runGit, input.cwd, input.changeId, input.ignoredWorkspacePaths ?? []);
  if (!clean.ok) return clean;
  return {
    ok: true,
    sourcePath,
    targetPath,
    manifestDigest: computeArchiveManifestDigest(sourcePath),
    preArchiveHead: head.stdout.trim(),
  };
}

function requireCleanGitWorkspace(
  runGit: (args: string[], cwd: string) => CommandResult,
  cwd: string,
  changeId: string,
  ignoredAbsPaths: string[] = [],
): PrepareArchiveResult | { ok: true } {
  const status = runGit(["status", "--porcelain", "-uall"], cwd);
  if (status.status !== 0) {
    return { ok: false, safeReason: `Could not inspect archive Git state: ${trimmedOutput(status)}` };
  }
  if (!isWorkspaceStatusClean(status.stdout, cwd, ignoredAbsPaths)) {
    return { ok: false, safeReason: `Archive requires a clean workspace; unrelated or staged changes exist for ${changeId}.` };
  }
  return { ok: true };
}

function changedGitPaths(
  runGit: (args: string[], cwd: string) => CommandResult,
  cwd: string,
  ignoredAbsPaths: string[] = [],
): { ok: true; paths: string[] } | { ok: false; safeReason: string } {
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  const paths = new Set<string>();
  for (const args of commands) {
    const result = runGit(args, cwd);
    if (result.status !== 0) {
      return { ok: false, safeReason: `Could not inspect archive Git paths: ${trimmedOutput(result)}` };
    }
    for (const path of result.stdout.split(/\r?\n/).filter(Boolean)) paths.add(path.replace(/\\/g, "/"));
  }
  return { ok: true, paths: [...paths].sort() };
}

function proveUniqueArchiveCommit(input: {
  runGit: (args: string[], cwd: string) => CommandResult;
  cwd: string;
  preArchiveHead: string;
  sourceRelative: string;
  targetRelative: string;
}): { ok: true; archiveCommitSha: string } | { ok: false; safeReason: string } {
  const ancestor = input.runGit(["merge-base", "--is-ancestor", input.preArchiveHead, "HEAD"], input.cwd);
  if (ancestor.status !== 0) {
    return { ok: false, safeReason: "Pre-archive HEAD is not an ancestor of the current workspace HEAD." };
  }
  const listed = input.runGit(["rev-list", "--reverse", `${input.preArchiveHead}..HEAD`], input.cwd);
  if (listed.status !== 0) {
    return { ok: false, safeReason: `Could not enumerate archive commits: ${trimmedOutput(listed)}` };
  }
  const candidates: string[] = [];
  for (const commit of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const diff = input.runGit(
      ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "--format=", commit],
      input.cwd,
    );
    if (diff.status !== 0) {
      return { ok: false, safeReason: `Could not verify archive commit contents: ${trimmedOutput(diff)}` };
    }
    const entries = diff.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
    const touchesArchive = entries.some((entry) => entry.slice(1).some((path) =>
      isWithinGitPath(path ?? "", input.sourceRelative) || isWithinGitPath(path ?? "", input.targetRelative)
    ));
    if (!touchesArchive) continue;
    const coherentRename = entries.length > 0 && entries.every((entry) => {
      if (!/^R\d+$/.test(entry[0] ?? "") || entry.length !== 3) return false;
      const source = entry[1] ?? "";
      const target = entry[2] ?? "";
      if (!isWithinGitPath(source, input.sourceRelative) || !isWithinGitPath(target, input.targetRelative)) return false;
      return source.slice(input.sourceRelative.length) === target.slice(input.targetRelative.length);
    });
    if (!coherentRename) {
      return { ok: false, safeReason: "Archive Git history does not contain one coherent source-to-target rename." };
    }
    candidates.push(commit);
  }
  if (candidates.length !== 1) {
    return { ok: false, safeReason: `Archive Git history has ${candidates.length} verified archive commits; exactly one is required.` };
  }
  return { ok: true, archiveCommitSha: candidates[0]! };
}

function gitRelativePath(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(path)).replace(/\\/g, "/");
}

function isWithinGitPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function matchingArchivePaths(cwd: string, changeId: string): string[] {
  const archiveDir = resolve(cwd, "openspec", "changes", "archive");
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir)
    .filter((entry) => entry.endsWith(`-${changeId}`))
    .map((entry) => resolve(archiveDir, entry))
    .sort();
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

function renderProposalTemplate(change: ManagedChangePlanEntry): string {
  return [
    `# Proposal: ${change.id}`,
    "",
    "## Why",
    "",
    change.rationale,
    "",
    "## What Changes",
    "",
    `<!-- Spec-writer: describe what "${change.title}" changes. -->`,
    "",
    ...(change.dependsOn && change.dependsOn.length > 0
      ? ["## Depends On", "", ...change.dependsOn.map((dep) => `- ${dep}`), ""]
      : []),
  ].join("\n");
}

function renderTasksTemplate(change: ManagedChangePlanEntry): string {
  return [
    `# Tasks: ${change.id}`,
    "",
    "<!-- Spec-writer: every task needs a checkbox line and an indented",
    "     'Acceptance:' line with binary, testable conditions. -->",
    "",
  ].join("\n");
}

/**
 * Internal structural gates, applied in both modes:
 * S2 — every requirement in specs/ has at least one WHEN/THEN scenario;
 * S3 — every task in tasks.md carries an Acceptance line.
 * Presence checks stand in for CLI validation when the CLI is unavailable.
 */
function structuralChecks(cwd: string, changeId: string): string[] {
  const failures: string[] = [];
  const changeDir = join(cwd, "openspec", "changes", changeId);
  if (!existsSync(join(changeDir, "proposal.md"))) {
    failures.push("proposal.md is missing");
  }

  const specFiles = listSpecFiles(join(changeDir, "specs"));
  if (specFiles.length === 0) {
    failures.push("no spec files found under specs/");
  }
  for (const file of specFiles) {
    const content = readFileSync(file, "utf8");
    if (!/^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements/m.test(content)) {
      failures.push(`${file} needs a delta section header (e.g. "## ADDED Requirements")`);
    }
    const requirements = content.split(/^### Requirement:/m).slice(1);
    if (requirements.length === 0) {
      failures.push(`${file} contains no requirements`);
    }
    for (const requirement of requirements) {
      const title = requirement.split("\n", 1)[0]?.trim() ?? "(untitled)";
      if (!/^#### Scenario:/m.test(requirement) || !/\*\*WHEN\*\*/.test(requirement) || !/\*\*THEN\*\*/.test(requirement)) {
        failures.push(`requirement "${title}" needs at least one WHEN/THEN scenario`);
      }
    }
  }

  const tasksPath = join(changeDir, "tasks.md");
  if (!existsSync(tasksPath)) {
    failures.push("tasks.md is missing");
  } else {
    const lines = readFileSync(tasksPath, "utf8").split(/\r?\n/);
    const taskIndexes = lines.flatMap((line, index) => (/^\s*- \[[ x]\]/.test(line) ? [index] : []));
    if (taskIndexes.length === 0) {
      failures.push("tasks.md contains no tasks");
    }
    for (const index of taskIndexes) {
      const next = taskIndexes.find((candidate) => candidate > index) ?? lines.length;
      const block = lines.slice(index, next).join("\n");
      if (!/Acceptance:/i.test(block)) {
        failures.push(`task "${lines[index]?.trim()}" is missing an acceptance line`);
      }
    }
  }

  return failures;
}

function listSpecFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listSpecFiles(path));
    } else if (entry.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function defaultDetectOpenSpecCli(): string | null {
  const result = detectCliCommand(
    {
      commandNames: (platform) => (platform === "win32" ? ["openspec.cmd", "openspec"] : ["openspec"]),
      commandSupports: (path) => {
        const probe = spawnSync(path, ["--version"], {
          encoding: "utf8",
          shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(path),
          timeout: 5_000,
          windowsHide: true,
        });
        return probe.status === 0;
      },
      commonPaths: () => [],
      messages: {
        notFound: "OpenSpec CLI was not found.",
        manual: "OpenSpec CLI detected from manual path.",
        path: "OpenSpec CLI detected on PATH.",
        common: "OpenSpec CLI detected in a common location.",
      },
    },
    {},
  );
  return result.commandPath;
}

function defaultRunCommand(args: string[], cwd: string): CommandResult {
  const command = defaultDetectOpenSpecCli();
  if (!command) return { status: 1, stdout: "", stderr: "OpenSpec CLI unavailable" };
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function defaultRunGit(args: string[], cwd: string): CommandResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function trimmedOutput(result: CommandResult): string {
  return `${result.stderr} ${result.stdout}`.replace(/\s+/g, " ").trim().slice(0, 300);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
