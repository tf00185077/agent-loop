import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ManagedChangePlanEntry } from "../../domain/index.js";
import { detectCliCommand } from "../cli/cli-command-detection.js";

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
}

export interface ArchiveChangeResult {
  ok: boolean;
  safeReason?: string;
}

export interface OpenSpecWorkspaceService {
  mode(): "cli" | "degraded";
  scaffoldChange(input: ScaffoldChangeInput): ScaffoldChangeResult;
  validateChange(input: ValidateChangeInput): ValidateChangeResult;
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

    archiveChange(input) {
      // Archive is a dated move in both modes: deterministic, CLI-version
      // independent, and identical to how this repo's own changes archive.
      const changeDir = join(input.cwd, "openspec", "changes", input.changeId);
      const archiveDir = join(input.cwd, "openspec", "changes", "archive");
      const target = join(archiveDir, `${input.date}-${input.changeId}`);
      try {
        if (!existsSync(changeDir)) {
          return { ok: false, safeReason: `Change directory not found: ${input.changeId}` };
        }
        if (existsSync(target)) {
          return { ok: false, safeReason: `Archive target already exists for ${input.changeId}` };
        }
        mkdirSync(archiveDir, { recursive: true });
        renameSync(changeDir, target);
      } catch (err) {
        return { ok: false, safeReason: `Could not archive ${input.changeId}: ${message(err)}` };
      }
      runGit(["add", "-A", join("openspec", "changes")], input.cwd);
      runGit(["commit", "-m", `openspec: archive ${input.changeId}`, "--no-verify"], input.cwd);
      return { ok: true };
    },
  };
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
