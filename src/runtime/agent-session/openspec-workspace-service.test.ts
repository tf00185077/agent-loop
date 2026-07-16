import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createOpenSpecWorkspaceService } from "./openspec-workspace-service.js";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "auto-agent-openspec-ws-"));
}

const planEntry = {
  id: "change-core",
  title: "Core loop",
  rationale: "Foundation for both game modes.",
  dependsOn: null,
};

test("scaffolds a change from internal templates and commits when git is available", () => {
  const cwd = tempWorkspace();
  const gitCalls: string[][] = [];
  const service = createOpenSpecWorkspaceService({
    detectCli: () => null,
    runGit: (args) => {
      gitCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = service.scaffoldChange({ cwd, change: planEntry });

  assert.equal(result.ok, true);
  const proposal = readFileSync(join(cwd, "openspec", "changes", "change-core", "proposal.md"), "utf8");
  assert.match(proposal, /Core loop/);
  assert.match(proposal, /Foundation for both game modes/);
  assert.ok(existsSync(join(cwd, "openspec", "changes", "change-core", "tasks.md")));
  assert.ok(existsSync(join(cwd, "openspec", "changes", "change-core", "specs")));
  assert.ok(gitCalls.some((args) => args[0] === "add"));
  assert.ok(
    gitCalls.some((args) => args[0] === "commit" && args.join(" ").includes("openspec: scaffold change-core")),
  );
});

test("reports degraded mode once when the CLI is missing and uses internal validation", () => {
  const cwd = tempWorkspace();
  const service = createOpenSpecWorkspaceService({
    detectCli: () => null,
    runGit: (args) => args[0] === "rev-parse"
      ? { status: 0, stdout: "head-one\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" },
  });

  assert.equal(service.mode(), "degraded");
  service.scaffoldChange({ cwd, change: planEntry });
  // Scaffold templates alone do not pass structural checks (placeholders).
  const empty = service.validateChange({ cwd, changeId: "change-core" });
  assert.equal(empty.ok, false);
  assert.ok(empty.failures.length > 0);
});

test("internal structural checks enforce scenarios and per-task acceptance", () => {
  const cwd = tempWorkspace();
  const service = createOpenSpecWorkspaceService({
    detectCli: () => null,
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  service.scaffoldChange({ cwd, change: planEntry });
  const changeDir = join(cwd, "openspec", "changes", "change-core");
  mkdirSync(join(changeDir, "specs", "core-loop"), { recursive: true });
  writeFileSync(
    join(changeDir, "specs", "core-loop", "spec.md"),
    [
      "# core-loop Specification (Delta)",
      "",
      "## ADDED Requirements",
      "",
      "### Requirement: Players can move",
      "The system SHALL let players move.",
      "",
      "#### Scenario: Move forward",
      "- **WHEN** the player presses forward",
      "- **THEN** the character advances",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(changeDir, "tasks.md"),
    [
      "# Tasks",
      "",
      "## 1. Core",
      "",
      "- [ ] 1.1 Implement movement",
      "  - Acceptance: A1: pressing forward advances the character.",
      "",
    ].join("\n"),
    "utf8",
  );

  const valid = service.validateChange({ cwd, changeId: "change-core" });
  assert.deepEqual(valid, { ok: true, failures: [] });

  // A spec file without a delta section header cannot validate as a change.
  writeFileSync(
    join(changeDir, "specs", "core-loop", "spec.md"),
    [
      "### Requirement: Players can move",
      "The system SHALL let players move.",
      "",
      "#### Scenario: Move forward",
      "- **WHEN** the player presses forward",
      "- **THEN** the character advances",
      "",
    ].join("\n"),
    "utf8",
  );
  const noDelta = service.validateChange({ cwd, changeId: "change-core" });
  assert.equal(noDelta.ok, false);
  assert.ok(noDelta.failures.some((failure) => /delta/i.test(failure)));

  // A requirement without a scenario fails S2.
  writeFileSync(
    join(changeDir, "specs", "core-loop", "spec.md"),
    ["### Requirement: Players can move", "The system SHALL let players move.", ""].join("\n"),
    "utf8",
  );
  const noScenario = service.validateChange({ cwd, changeId: "change-core" });
  assert.equal(noScenario.ok, false);
  assert.ok(noScenario.failures.some((failure) => /scenario/i.test(failure)));

  // A task without acceptance fails S3.
  writeFileSync(
    join(changeDir, "specs", "core-loop", "spec.md"),
    [
      "### Requirement: Players can move",
      "#### Scenario: Move",
      "- **WHEN** input",
      "- **THEN** output",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(changeDir, "tasks.md"), "- [ ] 1.1 Implement movement\n", "utf8");
  const noAcceptance = service.validateChange({ cwd, changeId: "change-core" });
  assert.equal(noAcceptance.ok, false);
  assert.ok(noAcceptance.failures.some((failure) => /acceptance/i.test(failure)));
});

test("runs the CLI validator in cli mode and degrades on CLI failure", () => {
  const cwd = tempWorkspace();
  const cliCalls: string[][] = [];
  const service = createOpenSpecWorkspaceService({
    detectCli: () => "C:\\Tools\\openspec.cmd",
    runCli: (args) => {
      cliCalls.push(args);
      return { status: 0, stdout: "valid", stderr: "" };
    },
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  service.scaffoldChange({ cwd, change: planEntry });
  const changeDir = join(cwd, "openspec", "changes", "change-core");
  mkdirSync(join(changeDir, "specs", "x"), { recursive: true });
  writeFileSync(
    join(changeDir, "specs", "x", "spec.md"),
    ["## ADDED Requirements", "", "### Requirement: R", "#### Scenario: S", "- **WHEN** a", "- **THEN** b", ""].join("\n"),
    "utf8",
  );
  writeFileSync(join(changeDir, "tasks.md"), "- [ ] 1.1 T\n  - Acceptance: A1: done.\n", "utf8");

  assert.equal(service.mode(), "cli");
  const result = service.validateChange({ cwd, changeId: "change-core" });
  assert.deepEqual(result, { ok: true, failures: [] });
  assert.ok(cliCalls.some((args) => args.includes("validate") && args.includes("change-core")));

  const failing = createOpenSpecWorkspaceService({
    detectCli: () => "C:\\Tools\\openspec.cmd",
    runCli: () => ({ status: 1, stdout: "", stderr: "invalid change" }),
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const failed = failing.validateChange({ cwd, changeId: "change-core" });
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some((failure) => /invalid change/.test(failure)));
});

test("archives a change by moving it into the dated archive directory", () => {
  const cwd = realGitArchiveWorkspace();
  const service = createOpenSpecWorkspaceService({ detectCli: () => null });

  const result = service.archiveChange({ cwd, changeId: "change-core", date: "2026-07-13" });

  assert.equal(result.ok, true);
  assert.ok(!existsSync(join(cwd, "openspec", "changes", "change-core")));
  assert.ok(
    existsSync(join(cwd, "openspec", "changes", "archive", "2026-07-13-change-core", "proposal.md")),
  );
});

test("prepares a fixed archive identity and reconciles exact replay idempotently", () => {
  const cwd = realGitArchiveWorkspace();
  const service = createOpenSpecWorkspaceService({ detectCli: () => null });

  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
  assert.equal(prepared.ok, true);
  assert.match(prepared.ok ? prepared.manifestDigest : "", /^[0-9a-f]{64}$/);
  assert.match(prepared.ok ? prepared.preArchiveHead : "", /^[0-9a-f]{40}$/);
  const first = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17",
    ...(prepared.ok ? prepared : {}),
  });
  assert.equal(first.ok, true);
  const replay = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17",
    ...(prepared.ok ? prepared : {}),
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
});

test("terminal archive replay accepts a later descendant HEAD while preserving the committed archive SHA", () => {
  const cwd = realGitArchiveWorkspace();
  const service = createOpenSpecWorkspaceService({ detectCli: () => null });
  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
  assert.equal(prepared.ok, true);
  const first = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17", ...(prepared.ok ? prepared : {}),
  });
  assert.match(first.archiveCommitSha ?? "", /^[0-9a-f]{40}$/);
  writeFileSync(join(cwd, "unrelated.txt"), "later descendant\n", "utf8");
  git(cwd, ["add", "unrelated.txt"]);
  git(cwd, ["commit", "-m", "later descendant"]);

  const replay = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17", ...(prepared.ok ? prepared : {}),
    archiveCommitSha: first.archiveCommitSha,
  });

  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.archiveCommitSha, first.archiveCommitSha);
});

test("fails closed when archive source and fixed target both exist", () => {
  const cwd = tempWorkspace();
  const service = createOpenSpecWorkspaceService({
    detectCli: () => null,
    runGit: (args) => args[0] === "rev-parse"
      ? { status: 0, stdout: "head-one\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" },
  });
  service.scaffoldChange({ cwd, change: planEntry });
  mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-07-17-change-core"), { recursive: true });

  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });

  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.match(prepared.safeReason, /ambiguous|both/i);
});

test("refuses to archive when an unrelated change is already staged", () => {
  const cwd = realGitArchiveWorkspace();
  writeFileSync(join(cwd, "unrelated.txt"), "staged mutation\n", "utf8");
  git(cwd, ["add", "unrelated.txt"]);
  const service = createOpenSpecWorkspaceService({ detectCli: () => null });

  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });

  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.match(prepared.safeReason, /clean|unrelated|workspace/i);
  assert.ok(existsSync(join(cwd, "openspec", "changes", "change-core")));
  assert.match(git(cwd, ["diff", "--cached", "--name-only"]).stdout, /^unrelated\.txt$/m);
});

test("pending archive restart proves the unique archive commit instead of adopting current HEAD", () => {
  const cwd = realGitArchiveWorkspace();
  const service = createOpenSpecWorkspaceService({ detectCli: () => null });
  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const first = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
  });
  assert.equal(first.ok, true);
  const archiveCommitSha = first.archiveCommitSha!;
  writeFileSync(join(cwd, "unrelated.txt"), "later descendant\n", "utf8");
  git(cwd, ["add", "unrelated.txt"]);
  git(cwd, ["commit", "-m", "later unrelated commit"]);
  const laterHead = git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  assert.notEqual(laterHead, archiveCommitSha);

  const reconciled = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
  });

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.idempotent, true);
  assert.equal(reconciled.archiveCommitSha, archiveCommitSha);
});

test("returns a bounded failure when real Git cannot stage the moved archive", () => {
  const cwd = realGitArchiveWorkspace();
  const service = createOpenSpecWorkspaceService({ detectCli: () => null });
  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  writeFileSync(join(cwd, ".git", "index.lock"), "locked\n", "utf8");

  const result = service.archiveChange({
    cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.safeReason ?? "", /stage archive|index\.lock/i);
  assert.ok(existsSync(join(cwd, "openspec", "changes", "archive", "2026-07-17-change-core")));
});

test("fails closed when archive content changes after preparation but before Git commit", () => {
  const cwd = realGitArchiveWorkspace();
  const sourceProposal = join(cwd, "openspec", "changes", "change-core", "proposal.md");
  writeFileSync(sourceProposal, `${"stable proposal line\n".repeat(200)}`, "utf8");
  git(cwd, ["add", sourceProposal]);
  git(cwd, ["commit", "-m", "large stable archive manifest"]);
  const targetProposal = join(
    cwd,
    "openspec",
    "changes",
    "archive",
    "2026-07-17-change-core",
    "proposal.md",
  );
  let injected = false;
  const service = createOpenSpecWorkspaceService({
    detectCli: () => null,
    runGit(args, gitCwd) {
      if (!injected && args[0] === "add" && args.includes("openspec/changes/archive/2026-07-17-change-core")) {
        writeFileSync(targetProposal, `${"stable proposal line\n".repeat(200)}tampered after durable preparation\n`, "utf8");
        injected = true;
      }
      const result = spawnSync("git", args, { cwd: gitCwd, encoding: "utf8" });
      return {
        status: result.status,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
      };
    },
  });
  const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const result = service.archiveChange({
    cwd,
    changeId: "change-core",
    date: "2026-07-17",
    ...prepared,
  });

  assert.equal(injected, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.safeReason ?? "", /manifest digest mismatch/i);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]).stdout.trim(), prepared.preArchiveHead);
  assert.equal(git(cwd, ["rev-list", "--count", `${prepared.preArchiveHead}..HEAD`]).stdout.trim(), "0");
});

test("pending restart rejects zero, mismatched, and conflicting archive commit proofs", () => {
  {
    const cwd = realGitArchiveWorkspace();
    const service = createOpenSpecWorkspaceService({ detectCli: () => null });
    const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const archived = service.archiveChange({ cwd, changeId: "change-core", date: "2026-07-17", ...prepared });
    assert.equal(archived.ok, true);
    assert.ok(archived.archiveCommitSha);
    const zero = service.archiveChange({
      cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
      preArchiveHead: archived.archiveCommitSha,
    });
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.match(zero.safeReason ?? "", /0 verified archive commits|exactly one/i);
    const mismatch = service.archiveChange({
      cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
      archiveCommitSha: prepared.preArchiveHead,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.safeReason ?? "", /recorded archive commit does not match/i);
  }

  {
    const cwd = realGitArchiveWorkspace();
    const service = createOpenSpecWorkspaceService({ detectCli: () => null });
    const prepared = service.prepareArchive!({ cwd, changeId: "change-core", date: "2026-07-17" });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(service.archiveChange({
      cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
    }).ok, true);
    const source = join(cwd, "openspec", "changes", "change-core");
    const target = join(cwd, "openspec", "changes", "archive", "2026-07-17-change-core");
    renameSync(target, source);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "conflicting reverse move"]);
    renameSync(source, target);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "conflicting second archive move"]);

    const conflicting = service.archiveChange({
      cwd, changeId: "change-core", date: "2026-07-17", ...prepared,
    });

    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.match(conflicting.safeReason ?? "", /history|coherent|exactly one/i);
  }
});

function realGitArchiveWorkspace(): string {
  const cwd = tempWorkspace();
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Archive Test"]);
  git(cwd, ["config", "user.email", "archive@example.invalid"]);
  const source = join(cwd, "openspec", "changes", "change-core");
  mkdirSync(join(source, "specs", "core"), { recursive: true });
  writeFileSync(join(source, "proposal.md"), "# Proposal\n", "utf8");
  writeFileSync(join(source, "tasks.md"), "# Tasks\n", "utf8");
  writeFileSync(join(source, "specs", "core", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(cwd, "unrelated.txt"), "initial\n", "utf8");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}
