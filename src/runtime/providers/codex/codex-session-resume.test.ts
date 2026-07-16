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
    ["exec", "resume", "sess-123", "--skip-git-repo-check", "--json", "--sandbox", "workspace-write", "-"],
  );
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
