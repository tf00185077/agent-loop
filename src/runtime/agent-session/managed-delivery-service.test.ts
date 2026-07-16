import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedDeliveryService } from "./managed-delivery-service.js";

test("creates a runtime candidate, applies it, validates, and records the supervisor commit", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.worker, "feature.txt"), "delivered\n");
  const result = createManagedDeliveryService({ fixedValidationCommand: `node -e "process.exit(0)"` }).deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
  });
  assert.equal(result.status, "committed");
  assert.match(result.commitSha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
});

test("applies an exact pre-created resolved candidate under backend authority", () => {
  const fixture = gitFixture();
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(fixture.worker, "resolved.txt"), "resolved\n");
  git(fixture.worker, ["add", "resolved.txt"]);
  git(fixture.worker, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "resolved"]);
  const candidate = git(fixture.worker, ["rev-parse", "HEAD"]).stdout.trim();

  const service = createManagedDeliveryService({ fixedValidationCommand: `node -e "process.exit(0)"` });
  const result = service.deliverCandidate!({
    supervisorCwd: fixture.supervisor,
    checkpointHead: checkpoint,
    candidateCommitSha: candidate,
    safeSummary: "Resolved candidate accepted",
  });
  assert.equal(result.status, "committed");
  assert.equal(result.candidateCommitSha, candidate);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
});

test("fails closed when the worker changed after attestation", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.worker, "feature.txt"), "expected\n");
  writeFileSync(join(fixture.worker, "extra.txt"), "stale\n");
  const result = createManagedDeliveryService().deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
  });
  assert.equal(result.status, "verification_failed");
});

test("refuses to apply to a dirty supervisor workspace", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.worker, "feature.txt"), "candidate\n");
  writeFileSync(join(fixture.supervisor, "dirty.txt"), "dirty\n");
  const result = createManagedDeliveryService().deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
  });
  assert.equal(result.status, "verification_failed");
  assert.match(result.safeSummary, /dirty/i);
});

test("rolls back and verifies the checkpoint when fixed validation fails", () => {
  const fixture = gitFixture();
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(fixture.worker, "feature.txt"), "candidate\n");
  const result = createManagedDeliveryService({ fixedValidationCommand: `node -e "process.exit(7)"` }).deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
  });
  assert.equal(result.status, "test_failed_reverted");
  assert.equal(result.validationExitCode, 7);
  assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
});

test("records conflict and restores the clean supervisor checkpoint", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.worker, "base.txt"), "worker\n");
  writeFileSync(join(fixture.supervisor, "base.txt"), "supervisor\n");
  git(fixture.supervisor, ["add", "base.txt"]);
  git(fixture.supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "supervisor"]);
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  const result = createManagedDeliveryService().deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["base.txt"], safeSummary: "Deliver",
  });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.candidateFiles, ["base.txt"]);
  assert.deepEqual(result.conflictFiles, ["base.txt"]);
  assert.match(result.conflictSummary ?? "", /conflict/i);
  assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
});

test("records revert_failed when rollback cannot restore the checkpoint", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.worker, "feature.txt"), "candidate\n");
  const runGit = (input: { cwd: string; args: string[] }) => {
    if (input.cwd === fixture.supervisor && input.args[0] === "reset") {
      return { status: 1, stderr: "simulated reset failure" };
    }
    const result = spawnSync("git", input.args, { cwd: input.cwd, encoding: "utf8", windowsHide: true });
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };
  const result = createManagedDeliveryService({
    fixedValidationCommand: `node -e "process.exit(9)"`,
    runGit,
  }).deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
  });
  assert.equal(result.status, "revert_failed");
  assert.match(result.rollbackSummary ?? "", /failed/i);
});

test("prepareCandidate creates a candidate + checkpoint without mutating the supervisor", () => {
  const fixture = gitFixture();
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(fixture.worker, "feature.txt"), "delivered\n");

  const prepared = createManagedDeliveryService().prepareCandidate({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Prep",
  });

  assert.ok(prepared.ok);
  if (prepared.ok) {
    assert.match(prepared.candidateCommitSha, /^[0-9a-f]{40}$/);
    assert.equal(prepared.checkpointHead, checkpoint);
    assert.deepEqual(prepared.candidateFiles, ["feature.txt"]);
  }
  // The supervisor workspace must be untouched (no cherry-pick yet).
  assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
});

test("prepareCandidate fails closed when the worker changed after attestation", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.worker, "feature.txt"), "expected\n");
  writeFileSync(join(fixture.worker, "extra.txt"), "stale\n");

  const prepared = createManagedDeliveryService().prepareCandidate({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Prep",
  });

  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.result.status, "verification_failed");
});

test("prepareCandidate reserves archive, main-spec sync, and active-change deletion paths", () => {
  for (const scenario of [
    { path: "openspec/changes/archive/2026-07-17-change-a/proposal.md", kind: "add" },
    { path: "openspec/specs/core/spec.md", kind: "add" },
    { path: "openspec/changes/change-a/proposal.md", kind: "delete" },
  ] as const) {
    const fixture = gitFixture();
    if (scenario.kind === "delete") {
      mkdirSync(join(fixture.supervisor, "openspec", "changes", "change-a"), { recursive: true });
      writeFileSync(join(fixture.supervisor, scenario.path), "proposal\n");
      git(fixture.supervisor, ["add", scenario.path]);
      git(fixture.supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "active"]);
      git(fixture.worker, ["reset", "--hard", git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim()]);
      rmSync(join(fixture.worker, scenario.path));
    } else {
      mkdirSync(join(fixture.worker, scenario.path, ".."), { recursive: true });
      writeFileSync(join(fixture.worker, scenario.path), "provider mutation\n");
    }

    const prepared = createManagedDeliveryService().prepareCandidate({
      workerCwd: fixture.worker,
      supervisorCwd: fixture.supervisor,
      attestedFiles: [scenario.path],
      activeChangeId: "change-a",
      safeSummary: "Provider attempted backend-owned mutation",
    });

    assert.equal(prepared.ok, false, scenario.path);
    if (!prepared.ok) assert.match(prepared.result.safeSummary, /backend-owned|reserved/i);
  }
});

test("prepareCandidate allows ordinary active spec and production edits", () => {
  const fixture = gitFixture();
  const paths = ["openspec/changes/change-a/design.md", "src/feature.ts", "src/feature.test.ts"];
  for (const path of paths) {
    mkdirSync(join(fixture.worker, path, ".."), { recursive: true });
    writeFileSync(join(fixture.worker, path), "allowed\n");
  }

  const prepared = createManagedDeliveryService().prepareCandidate({
    workerCwd: fixture.worker,
    supervisorCwd: fixture.supervisor,
    attestedFiles: paths,
    activeChangeId: "change-a",
    safeSummary: "Normal candidate",
  });

  assert.equal(prepared.ok, true);
});

test("reconcilePendingDelivery resets a delivered commit back to the checkpoint", () => {
  const fixture = gitFixture();
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(fixture.worker, "feature.txt"), "delivered\n");
  const service = createManagedDeliveryService({ fixedValidationCommand: `node -e "process.exit(0)"` });
  const delivered = service.deliver({
    workerCwd: fixture.worker, supervisorCwd: fixture.supervisor, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
  });
  assert.equal(delivered.status, "committed");
  assert.notEqual(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);

  const reconciled = service.reconcilePendingDelivery({ supervisorCwd: fixture.supervisor, checkpointHead: checkpoint });

  assert.equal(reconciled.status, "reset");
  assert.equal(reconciled.reset, true);
  assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
});

test("reconcilePendingDelivery is a no-op when already at the checkpoint", () => {
  const fixture = gitFixture();
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();

  const reconciled = createManagedDeliveryService()
    .reconcilePendingDelivery({ supervisorCwd: fixture.supervisor, checkpointHead: checkpoint });

  assert.equal(reconciled.status, "at_checkpoint");
  assert.equal(reconciled.reset, false);
  assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);
});

test("reconcilePendingDelivery fails closed when an ignored generated artifact cannot be proven absent", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.supervisor, ".gitignore"), "generated/\n", "utf8");
  git(fixture.supervisor, ["add", ".gitignore"]);
  git(fixture.supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "ignore generated"]);
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  mkdirSync(join(fixture.supervisor, "generated"), { recursive: true });
  writeFileSync(join(fixture.supervisor, "generated", "stale.log"), "stale runtime output\n", "utf8");

  const reconciled = createManagedDeliveryService()
    .reconcilePendingDelivery({ supervisorCwd: fixture.supervisor, checkpointHead: checkpoint });

  assert.equal(reconciled.status, "reset_failed");
  assert.equal(reconciled.reset, false);
  assert.match(reconciled.safeSummary, /ignored workspace artifacts prevent exact checkpoint reconciliation/i);
  assert.match(git(fixture.supervisor, ["status", "--porcelain", "--ignored", "-uall"]).stdout, /generated\/stale\.log/);
});

test("reconcilePendingDelivery preserves explicitly protected ignored supervisor inputs", () => {
  const fixture = gitFixture();
  writeFileSync(join(fixture.supervisor, ".gitignore"), ".env\nnode_modules/\n", "utf8");
  git(fixture.supervisor, ["add", ".gitignore"]);
  git(fixture.supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "protect local inputs"]);
  const checkpoint = git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(fixture.supervisor, ".env"), "LOCAL_ONLY=1\n", "utf8");
  mkdirSync(join(fixture.supervisor, "node_modules", "local-package"), { recursive: true });
  writeFileSync(join(fixture.supervisor, "node_modules", "local-package", "index.js"), "module.exports = 1;\n", "utf8");

  const reconciled = createManagedDeliveryService()
    .reconcilePendingDelivery({ supervisorCwd: fixture.supervisor, checkpointHead: checkpoint });

  assert.equal(reconciled.status, "at_checkpoint");
  assert.equal(existsSync(join(fixture.supervisor, ".env")), true);
  assert.equal(existsSync(join(fixture.supervisor, "node_modules", "local-package", "index.js")), true);
});

function gitFixture(): { supervisor: string; worker: string } {
  const root = mkdtempSync(join(tmpdir(), "managed-delivery-"));
  const supervisor = join(root, "repo");
  const worker = join(root, "worker");
  git(root, ["init", supervisor]);
  writeFileSync(join(supervisor, "base.txt"), "base\n");
  git(supervisor, ["add", "base.txt"]);
  git(supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "base"]);
  git(supervisor, ["worktree", "add", "--detach", worker, "HEAD"]);
  return { supervisor, worker };
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !args.includes("cherry-pick")) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}
