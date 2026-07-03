import assert from "node:assert/strict";
import test from "node:test";

import { createGitReviewMergeWorkspaceService } from "./review-merge-workspace-service.js";

test("records a checkpoint when the supervisor workspace is clean", async () => {
  const calls: string[][] = [];
  const service = createGitReviewMergeWorkspaceService({
    runGit(input) {
      calls.push(input.args);
      if (input.args[0] === "status") return { status: 0, stdout: "" };
      return { status: 0, stdout: "abc123\n" };
    },
  });

  const result = await service.prepareReviewMerge("C:\\repo");

  assert.deepEqual(result, { ok: true, checkpoint: { head: "abc123", statusSummary: "clean" } });
  assert.deepEqual(calls, [
    ["status", "--porcelain"],
    ["rev-parse", "HEAD"],
  ]);
});

test("rejects dirty supervisor workspaces before review merge starts", async () => {
  const service = createGitReviewMergeWorkspaceService({
    runGit() {
      return { status: 0, stdout: " M src/file.ts\n?? scratch.txt\n" };
    },
  });

  const result = await service.prepareReviewMerge("C:\\repo");

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.safeReason, /dirty/i);
  assert.match(result.ok ? "" : result.safeReason, /scratch\.txt/);
});
