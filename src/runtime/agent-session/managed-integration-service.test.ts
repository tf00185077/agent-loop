import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedIntegrationService } from "./managed-integration-service.js";
import { createManagedDeliveryService } from "./managed-delivery-service.js";
import { createGitWorktreeService } from "./worktree-service.js";

test("reproduces a real conflict and creates a backend-owned resolved candidate", async () => {
  const fixture = conflictingFixture();
  const service = integrationService(fixture.root);
  const prepared = await service.prepare({
    supervisorCwd: fixture.supervisor,
    integrationAttemptId: "integration-1",
    checkpointHead: fixture.checkpoint,
    originalCandidateCommitSha: fixture.candidate,
    candidateFiles: ["base.txt"],
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.ok ? prepared.conflictFiles : [], ["base.txt"]);
  if (!prepared.ok) return;

  writeFileSync(join(prepared.worktree.path, "base.txt"), "resolved\n");
  git(prepared.worktree.path, ["add", "base.txt"]);
  const resolved = service.verifyAndCreateCandidate({
    integrationCwd: prepared.worktree.path,
    checkpointHead: fixture.checkpoint,
    allowedFiles: ["base.txt"],
    safeSummary: "Resolve base conflict",
  });

  assert.equal(resolved.ok, true);
  assert.match(resolved.ok ? resolved.resolvedCandidateCommitSha : "", /^[0-9a-f]{40}$/);
  assert.equal(git(prepared.worktree.path, ["status", "--porcelain"]).stdout.trim(), "");
  assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), fixture.checkpoint);
  assert.equal(git(fixture.supervisor, ["status", "--porcelain"]).stdout.trim(), "");
  if (resolved.ok) {
    const delivered = createManagedDeliveryService({ fixedValidationCommand: "git diff --check HEAD^ HEAD" })
      .deliverCandidate!({
        supervisorCwd: fixture.supervisor,
        checkpointHead: fixture.checkpoint,
        candidateCommitSha: resolved.resolvedCandidateCommitSha,
        safeSummary: "Candidate-bound Judge accepted the resolved candidate.",
      });
    assert.equal(delivered.status, "committed");
    assert.equal(delivered.candidateCommitSha, resolved.resolvedCandidateCommitSha);
    assert.equal(git(fixture.supervisor, ["rev-parse", "HEAD"]).stdout.trim(), delivered.commitSha);
  }
  await service.cleanup({ supervisorCwd: fixture.supervisor, integrationCwd: prepared.worktree.path });
});

test("fails closed for unresolved, moved-head, empty, and out-of-scope integration results", async () => {
  const unresolvedFixture = conflictingFixture();
  const unresolvedService = integrationService(unresolvedFixture.root);
  const unresolved = await unresolvedService.prepare({
    supervisorCwd: unresolvedFixture.supervisor, integrationAttemptId: "integration-unresolved",
    checkpointHead: unresolvedFixture.checkpoint, originalCandidateCommitSha: unresolvedFixture.candidate,
    candidateFiles: ["base.txt"],
  });
  assert.equal(unresolved.ok, true);
  if (!unresolved.ok) return;
  assert.deepEqual(unresolvedService.verifyAndCreateCandidate({
    integrationCwd: unresolved.worktree.path, checkpointHead: unresolvedFixture.checkpoint,
    allowedFiles: ["base.txt"], safeSummary: "Still conflicted",
  }), { ok: false, status: "unresolved", safeSummary: "Integration worktree still has unresolved index entries." });

  writeFileSync(join(unresolved.worktree.path, "base.txt"), "supervisor\n");
  git(unresolved.worktree.path, ["add", "base.txt"]);
  assert.deepEqual(unresolvedService.verifyAndCreateCandidate({
    integrationCwd: unresolved.worktree.path, checkpointHead: unresolvedFixture.checkpoint,
    allowedFiles: ["base.txt"], safeSummary: "No effective change",
  }), { ok: false, status: "empty", safeSummary: "Integration produced no deliverable changes." });
  await unresolvedService.cleanup({ supervisorCwd: unresolvedFixture.supervisor, integrationCwd: unresolved.worktree.path });

  const scopeFixture = conflictingFixture();
  const scopeService = integrationService(scopeFixture.root);
  const scoped = await scopeService.prepare({
    supervisorCwd: scopeFixture.supervisor, integrationAttemptId: "integration-scope",
    checkpointHead: scopeFixture.checkpoint, originalCandidateCommitSha: scopeFixture.candidate,
    candidateFiles: ["base.txt"],
  });
  assert.equal(scoped.ok, true);
  if (!scoped.ok) return;
  writeFileSync(join(scoped.worktree.path, "base.txt"), "resolved\n");
  writeFileSync(join(scoped.worktree.path, "extra.txt"), "not allowed\n");
  git(scoped.worktree.path, ["add", "base.txt", "extra.txt"]);
  const scopeResult = scopeService.verifyAndCreateCandidate({
    integrationCwd: scoped.worktree.path, checkpointHead: scopeFixture.checkpoint,
    allowedFiles: ["base.txt"], safeSummary: "Out of scope",
  });
  assert.equal(scopeResult.ok, false);
  assert.equal(scopeResult.ok ? null : scopeResult.status, "scope_violation");
  await scopeService.cleanup({ supervisorCwd: scopeFixture.supervisor, integrationCwd: scoped.worktree.path });

  const movedFixture = conflictingFixture();
  const movedService = integrationService(movedFixture.root);
  const moved = await movedService.prepare({
    supervisorCwd: movedFixture.supervisor, integrationAttemptId: "integration-moved",
    checkpointHead: movedFixture.checkpoint, originalCandidateCommitSha: movedFixture.candidate,
    candidateFiles: ["base.txt"],
  });
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  git(moved.worktree.path, ["reset", "--hard", movedFixture.checkpoint]);
  writeFileSync(join(moved.worktree.path, "moved.txt"), "moved\n");
  git(moved.worktree.path, ["add", "moved.txt"]);
  git(moved.worktree.path, ["-c", "user.name=Integrator", "-c", "user.email=i@example.invalid", "commit", "-m", "forbidden"]);
  const movedResult = movedService.verifyAndCreateCandidate({
    integrationCwd: moved.worktree.path, checkpointHead: movedFixture.checkpoint,
    allowedFiles: ["base.txt"], safeSummary: "Moved HEAD",
  });
  assert.equal(movedResult.ok, false);
  assert.equal(movedResult.ok ? null : movedResult.status, "head_moved");
  await movedService.cleanup({ supervisorCwd: movedFixture.supervisor, integrationCwd: moved.worktree.path });
});

function integrationService(root: string) {
  return createManagedIntegrationService({
    worktreeService: createGitWorktreeService({ baseDir: join(root, "integrations") }),
  });
}

function conflictingFixture(): { root: string; supervisor: string; candidate: string; checkpoint: string } {
  const root = mkdtempSync(join(tmpdir(), "managed-integration-"));
  const supervisor = join(root, "repo");
  const worker = join(root, "worker");
  git(root, ["init", supervisor]);
  writeFileSync(join(supervisor, "base.txt"), "base\n");
  git(supervisor, ["add", "base.txt"]);
  git(supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "base"]);
  git(supervisor, ["worktree", "add", "--detach", worker, "HEAD"]);
  writeFileSync(join(worker, "base.txt"), "worker\n");
  git(worker, ["add", "base.txt"]);
  git(worker, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "candidate"]);
  const candidate = git(worker, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(supervisor, "base.txt"), "supervisor\n");
  git(supervisor, ["add", "base.txt"]);
  git(supervisor, ["-c", "user.name=Runtime", "-c", "user.email=runtime@example.invalid", "commit", "-m", "supervisor"]);
  return { root, supervisor, candidate, checkpoint: git(supervisor, ["rev-parse", "HEAD"]).stdout.trim() };
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !(args.includes("cherry-pick") && args.includes("--no-commit"))) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}
