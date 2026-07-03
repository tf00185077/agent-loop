import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGitWorktreeService } from "./worktree-service.js";

test("creates isolated child git worktrees with safe labels", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const baseDir = join(mkdtempSync(join(tmpdir(), "auto-agent-worktree-service-")), "children");
  const service = createGitWorktreeService({
    baseDir,
    runGit(input) {
      calls.push(input);
      return { status: 0 };
    },
  });

  const metadata = await service.createChildWorktree({
    parentCwd: "C:\\repo",
    childSessionId: "session:one",
  });

  assert.equal(metadata.label, "child-session-one");
  assert.equal(metadata.path, join(baseDir, "child-session-one"));
  assert.deepEqual(calls, [
    {
      cwd: "C:\\repo",
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
