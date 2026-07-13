import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
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
  const cwd = tempWorkspace();
  const service = createOpenSpecWorkspaceService({
    detectCli: () => null,
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  service.scaffoldChange({ cwd, change: planEntry });

  const result = service.archiveChange({ cwd, changeId: "change-core", date: "2026-07-13" });

  assert.equal(result.ok, true);
  assert.ok(!existsSync(join(cwd, "openspec", "changes", "change-core")));
  assert.ok(
    existsSync(join(cwd, "openspec", "changes", "archive", "2026-07-13-change-core", "proposal.md")),
  );
});
