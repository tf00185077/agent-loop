import assert from "node:assert/strict";
import test from "node:test";

import { createShellCheckRunner } from "./check-runner.js";

test("shell runner reports exit code and output", async () => {
  const runner = createShellCheckRunner();
  const pass = await runner.run({ cwd: process.cwd(), command: `node -e "console.log('ok')"`, timeoutMs: 30000 });
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.failedToRun, false);
  assert.match(pass.outputSummary, /ok/);

  const fail = await runner.run({ cwd: process.cwd(), command: `node -e "console.error('boom'); process.exit(3)"`, timeoutMs: 30000 });
  assert.equal(fail.exitCode, 3);
  assert.equal(fail.failedToRun, false);
  assert.match(fail.outputSummary, /boom/);
});

test("shell runner tears down a timed-out check and reports failedToRun", async () => {
  const runner = createShellCheckRunner();
  const started = Date.now();
  const result = await runner.run({
    cwd: process.cwd(),
    command: `node -e "setInterval(() => {}, 1000)"`,
    timeoutMs: 1500,
  });
  assert.equal(result.failedToRun, true);
  assert.equal(result.exitCode, null);
  assert.match(result.outputSummary, /timed out/);
  assert.ok(Date.now() - started < 10000, "the runner must not hang past its timeout");
});
