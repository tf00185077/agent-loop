import assert from "node:assert/strict";
import test from "node:test";

import { createReviewMergeVerificationService } from "./review-merge-verification-service.js";

const checkpoint = { head: "abc123", statusSummary: "clean" };

test("accepts merged only when the fixed review-merge test command passes", () => {
  const service = createReviewMergeVerificationService({
    fixedTestCommand: "npm run typecheck",
    runCommand() {
      return { status: 0, output: "ok" };
    },
  });

  const result = service.verifyMerged({ cwd: "C:\\repo", checkpoint });

  assert.equal(result.outcome, "merged");
  assert.deepEqual(result.fixedTest, {
    command: "npm run typecheck",
    exitCode: 0,
    outputSummary: "ok",
  });
});

test("records test_failed_reverted when fixed tests fail and checkpoint verification passes", () => {
  const gitCalls: string[][] = [];
  const service = createReviewMergeVerificationService({
    fixedTestCommand: "npm test",
    runCommand() {
      return { status: 1, output: "failing test output" };
    },
    runGit(input) {
      gitCalls.push(input.args);
      if (input.args[0] === "rev-parse") return { status: 0, stdout: "abc123\n" };
      return { status: 0, stdout: "" };
    },
  });

  const result = service.verifyMerged({ cwd: "C:\\repo", checkpoint });

  assert.equal(result.outcome, "test_failed_reverted");
  assert.equal(result.fixedTest.exitCode, 1);
  assert.deepEqual(gitCalls, [
    ["reset", "--hard", "abc123"],
    ["clean", "-fd"],
    ["status", "--porcelain"],
    ["rev-parse", "HEAD"],
  ]);
  assert.equal(result.revertEvidence?.verified, true);
});

test("records revert_failed when failed tests cannot restore the checkpoint", () => {
  const service = createReviewMergeVerificationService({
    runCommand() {
      return { status: 1, output: "failing test output" };
    },
    runGit(input) {
      if (input.args[0] === "rev-parse") return { status: 0, stdout: "different-head\n" };
      return { status: 0, stdout: "" };
    },
  });

  const result = service.verifyMerged({ cwd: "C:\\repo", checkpoint });

  assert.equal(result.outcome, "revert_failed");
  assert.equal(result.revertEvidence?.verified, false);
});

test("records verification_failed when the fixed test command has no exit code", () => {
  const service = createReviewMergeVerificationService({
    runCommand() {
      return { status: null, output: "spawn failed" };
    },
  });

  const result = service.verifyMerged({ cwd: "C:\\repo", checkpoint });

  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.fixedTest.exitCode, null);
});
