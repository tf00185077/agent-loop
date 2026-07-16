import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createGitWorktreeService } from "./worktree-service.js";

test("creates isolated child git worktrees with safe labels", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const parentCwd = join(mkdtempSync(join(tmpdir(), "auto-agent-parent-repo-")), "repo");
  const baseDir = join(mkdtempSync(join(tmpdir(), "auto-agent-worktree-service-")), "children");
  const service = createGitWorktreeService({
    baseDir,
    runGit(input) {
      calls.push(input);
      return { status: 0 };
    },
  });

  const metadata = await service.createChildWorktree({
    parentCwd,
    childSessionId: "session:one",
  });

  assert.equal(metadata.label, "child-session-one");
  assert.equal(metadata.path, join(baseDir, "child-session-one"));
  assert.deepEqual(calls, [
    {
      cwd: resolve(parentCwd),
      args: ["worktree", "add", "--detach", metadata.path, "HEAD"],
    },
  ]);
});

test("surfaces sanitized git worktree failures", async () => {
  const service = createGitWorktreeService({
    runGit() {
      return { status: 128, stderr: "fatal:\n cannot create worktree" };
    },
  });

  await assert.rejects(
    () =>
      service.createChildWorktree({
        parentCwd: "C:\\repo",
        childSessionId: "session-one",
      }),
    /Failed to create child worktree: fatal: cannot create worktree/,
  );
});

test("creates an integration worktree at an exact checkpoint and removes it idempotently", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const parentCwd = join(mkdtempSync(join(tmpdir(), "auto-agent-parent-repo-")), "repo");
  const baseDir = join(mkdtempSync(join(tmpdir(), "auto-agent-integration-worktree-")), "children");
  const service = createGitWorktreeService({
    baseDir,
    runGit(input) {
      calls.push(input);
      return { status: 0 };
    },
  });

  const metadata = await service.createIntegrationWorktree!({
    parentCwd,
    integrationAttemptId: "integration:one",
    checkpointHead: "abc123",
  });
  await service.removeWorktree!({ parentCwd, path: metadata.path });

  assert.equal(metadata.label, "integration-integration-one");
  assert.deepEqual(calls, [
    { cwd: resolve(parentCwd), args: ["worktree", "add", "--detach", metadata.path, "abc123"] },
    { cwd: resolve(parentCwd), args: ["worktree", "remove", "--force", metadata.path] },
    { cwd: resolve(parentCwd), args: ["worktree", "prune"] },
  ]);
});
