import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionStartInput } from "../../../domain/index.js";
import {
  buildCodexManagedSessionArgs,
  createCodexRuntimeAdapter,
  detectCodexRuntimeCapabilities,
  type CodexRuntimeSessionRunnerInput,
} from "./codex-runtime-adapter.js";

const baseRunnerInput: CodexRuntimeSessionRunnerInput = {
  sessionId: "s", goalId: "g", runId: "r", prompt: "p", providerId: "codex-local", modelLabel: null,
  commandPath: "codex", signal: new AbortController().signal,
};

test("buildCodexManagedSessionArgs builds `exec resume <id>` when a resume session id is set", () => {
  assert.deepEqual(
    buildCodexManagedSessionArgs(baseRunnerInput),
    ["exec", "--skip-git-repo-check", "--json", "--sandbox", "workspace-write", "-"],
  );
  assert.deepEqual(
    buildCodexManagedSessionArgs({ ...baseRunnerInput, resumeSessionId: "sess-123" }),
    ["exec", "resume", "sess-123", "--skip-git-repo-check", "--json", "-c", "sandbox_mode=workspace-write", "-"],
  );
  // `exec resume` has no --sandbox flag.
  assert.ok(!buildCodexManagedSessionArgs({ ...baseRunnerInput, resumeSessionId: "sess-123" }).includes("--sandbox"));
});

test("a failed resume attempt falls back to a fresh session instead of failing", async () => {
  const attempts: Array<string | null> = [];
  const sessionRunner = async function* (input: CodexRuntimeSessionRunnerInput) {
    attempts.push(input.resumeSessionId ?? null);
    if (input.resumeSessionId) throw new Error("resume: unknown session");
    // fresh attempt: no events, completes cleanly
  };
  const adapter = createCodexRuntimeAdapter({
    commandPath: "codex", modelLabel: null,
    probe: async () => ({ execJson: true, approvalResume: false, sessionResume: true }),
    sessionRunner,
  });
  const handle = await adapter.startSession({
    sessionId: "s", goalId: "g", runId: "r", prompt: "p", providerId: "codex-local", modelLabel: null, resumeSessionId: "sess-9",
  });
  const types: string[] = [];
  for await (const event of handle.events()) types.push(event.type);

  assert.deepEqual(attempts, ["sess-9", null], "resume attempt then fresh fallback");
  assert.ok(!types.includes("session.failed"), "a failed resume must not surface a terminal failure");
  assert.ok(types.includes("session.completed"), "the fresh fallback session completed");
});

test("the resume capability is derived from session-resume support", async () => {
  const supported = await detectCodexRuntimeCapabilities({
    commandPath: "codex", probe: async () => ({ execJson: true, approvalResume: false, sessionResume: true }),
  });
  assert.equal(supported.resume, true);
  const unsupported = await detectCodexRuntimeCapabilities({
    commandPath: "codex", probe: async () => ({ execJson: true, approvalResume: false, sessionResume: false }),
  });
  assert.equal(unsupported.resume, false);
});

async function captureRunnerInput(sessionResume: boolean, resumeSessionId: string | null): Promise<CodexRuntimeSessionRunnerInput> {
  let captured: CodexRuntimeSessionRunnerInput | undefined;
  const adapter = createCodexRuntimeAdapter({
    commandPath: "codex", modelLabel: null,
    probe: async () => ({ execJson: true, approvalResume: false, sessionResume }),
    // eslint-disable-next-line require-yield
    sessionRunner: async function* (input) { captured = input; },
  });
  const start: AgentSessionStartInput = {
    sessionId: "s", goalId: "g", runId: "r", prompt: "p", providerId: "codex-local", modelLabel: null, resumeSessionId,
  };
  const handle = await adapter.startSession(start);
  for await (const _event of handle.events()) { /* drain */ }
  return captured!;
}

test("the adapter forwards resumeSessionId to the runner only when resume is supported", async () => {
  assert.equal((await captureRunnerInput(true, "sess-9")).resumeSessionId, "sess-9");
  assert.equal((await captureRunnerInput(false, "sess-9")).resumeSessionId, null);
});
