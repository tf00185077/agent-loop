import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
