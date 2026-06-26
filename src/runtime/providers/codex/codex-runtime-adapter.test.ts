import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv0 } from "node:process";
import test from "node:test";

import type { CodexJsonlParsedResult } from "./codex-jsonl-parser.js";
import { openDatabase } from "../../../persistence/database.js";
import { createGoalRepository } from "../../../persistence/goal-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "../../agent-session/agent-session-manager.js";
import {
  createCodexRuntimeAdapter,
  detectCodexRuntimeCapabilities,
  type CodexRuntimeCapabilityProbeResult,
} from "./codex-runtime-adapter.js";

test("detects Codex JSONL runtime capabilities with approval explicitly unsupported", async () => {
  const capabilities = await detectCodexRuntimeCapabilities({
    commandPath: "C:\\Tools\\codex.exe",
    probe: async () => ({
      execJson: true,
      approvalResume: false,
    }),
  });

  assert.equal(capabilities.eventStreaming, true);
  assert.equal(capabilities.approval, false);
  assert.equal(capabilities.cancellation, true);
  assert.equal(capabilities.resume, false);
  assert.equal(capabilities.childSessions, false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /approval resume/i);
});

test("detects approval-supported Codex mode only when the probe verifies resume support", async () => {
  const adapter = createCodexRuntimeAdapter({
    commandPath: "C:\\Tools\\codex.exe",
    modelLabel: "gpt-5-codex",
    probe: async () => ({
      execJson: true,
      approvalResume: true,
    }),
  });

  assert.deepEqual(await adapter.detectCapabilities(), {
    eventStreaming: true,
    approval: true,
    cancellation: true,
    resume: true,
    childSessions: false,
    unsupportedReasons: {
      child_sessions: "Child-session scheduling is not enabled for Codex runtime sessions.",
    },
  });
});

test("marks cancellation unavailable when Codex JSONL session mode is unavailable", async () => {
  const capabilities = await detectCodexRuntimeCapabilities({
    commandPath: "C:\\Users\\TIM\\AppData\\Roaming\\npm\\codex.cmd",
    probe: async () => ({
      execJson: false,
      approvalResume: false,
      reason: "codex exec --json is not supported by this CLI.",
    }),
  });

  assert.equal(capabilities.eventStreaming, false);
  assert.equal(capabilities.cancellation, false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /not supported/i);
  assert.match(capabilities.unsupportedReasons?.cancellation ?? "", /requires JSONL/i);
});

test("reports sanitized startup failure capabilities without command secrets", async () => {
  const capabilities = await detectCodexRuntimeCapabilities({
    commandPath: "C:\\Tools\\codex.cmd --api-key sk-secret --token hidden",
    probe: async (): Promise<CodexRuntimeCapabilityProbeResult> => {
      throw new Error("spawn C:\\Tools\\codex.cmd --api-key sk-secret --token hidden ENOENT");
    },
  });

  const serialized = JSON.stringify(capabilities);
  assert.equal(capabilities.eventStreaming, false);
  assert.equal(capabilities.approval, false);
  assert.equal(capabilities.cancellation, false);
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("hidden"), false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /failed to start/i);
});

test("maps Codex JSONL runtime events into durable managed goal events", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-codex-runtime-adapter-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Run managed Codex",
    description: "Map JSONL to durable events.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const adapter = createCodexRuntimeAdapter({
    commandPath: "C:\\Tools\\codex.exe",
    modelLabel: "gpt-5-codex",
    probe: async () => ({ execJson: true, approvalResume: false }),
    sessionRunner: async function* (): AsyncIterable<CodexJsonlParsedResult> {
      yield {
        observations: [
          {
            kind: "command.started",
            message: "Command started",
            command: { label: "npm test", status: "started" },
            metadata: { source: "jsonl", rawEventType: "item.started" },
          },
        ],
      };
      yield {
        observations: [
          {
            kind: "command.completed",
            message: "Command completed",
            command: { label: "npm test", status: "completed", exitCode: 0 },
            metadata: { source: "jsonl", rawEventType: "item.completed" },
          },
        ],
      };
      yield {
        observations: [
          {
            kind: "progress",
            message: "Final answer",
            metadata: { source: "jsonl", rawEventType: "agent_message" },
          },
        ],
        finalMessage: "Final answer",
      };
    },
  });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Do the work",
    adapter,
  });

  assert.equal(result.session.lifecycleState, "completed");
  assert.deepEqual(
    eventRepo.listForGoal(goal.id).map((event) => event.type),
    [
      "run.started",
      "agent.progress",
      "agent.command.started",
      "agent.command.completed",
      "agent.progress",
      "run.completed",
      "goal.completed",
    ],
  );
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  db.close();
});

test("starts Codex exec JSONL process and completes from streamed final message", async () => {
  const capturePath = join(mkdtempSync(join(tmpdir(), "auto-agent-codex-runtime-spawn-")), "capture.json");
  const commandPath = fakeCodexRuntimeProcess(capturePath, [
    JSON.stringify({ type: "item.started", item: { type: "command", command: "npm test" } }),
    JSON.stringify({ type: "agent_message", message: "Managed final answer" }),
  ]);
  const { goalRepo, eventRepo, manager, goal, close } = createManagedCodexHarness();
  const adapter = createCodexRuntimeAdapter({
    commandPath,
    modelLabel: "gpt-5-codex",
    probe: async () => ({ execJson: true, approvalResume: false }),
  });

  try {
    const result = await manager.startManagedSession({
      goalId: goal.id,
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      prompt: "Run from process",
      adapter,
    });

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[]; stdin: string };
    assert.equal(result.session.lifecycleState, "completed");
    assert.equal(goalRepo.getById(goal.id)?.status, "completed");
    assert.ok(captured.args.includes("exec"));
    assert.ok(captured.args.includes("--json"));
    assert.ok(captured.args.includes("--skip-git-repo-check"));
    const modelIndex = captured.args.indexOf("--model");
    assert.equal(captured.args[modelIndex + 1], "gpt-5-codex");
    assert.equal(captured.args.at(-1), "-");
    assert.equal(captured.stdin, "Run from process");
    assert.ok(eventRepo.listForGoal(goal.id).some((event) => event.message === "Managed final answer"));
  } finally {
    close();
  }
});

test("maps Codex process startup or non-zero exit into a failed managed session", async () => {
  const commandPath = fakeCodexRuntimeProcess(
    join(mkdtempSync(join(tmpdir(), "auto-agent-codex-runtime-fail-")), "capture.json"),
    [],
    { exitCode: 3, stderr: "boom --api-key sk-secret" },
  );
  const { goalRepo, manager, goal, close } = createManagedCodexHarness();
  const adapter = createCodexRuntimeAdapter({
    commandPath,
    modelLabel: "gpt-5-codex",
    probe: async () => ({ execJson: true, approvalResume: false }),
  });

  try {
    const result = await manager.startManagedSession({
      goalId: goal.id,
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      prompt: "Fail from process",
      adapter,
    });

    assert.equal(result.session.lifecycleState, "failed");
    assert.equal(goalRepo.getById(goal.id)?.status, "failed");
    assert.equal(JSON.stringify(result).includes("sk-secret"), false);
  } finally {
    close();
  }
});

test("adds safe Windows retry guidance for blocked PowerShell npm shims", async () => {
  const commandPath = fakeCodexRuntimeProcess(
    join(mkdtempSync(join(tmpdir(), "auto-agent-codex-runtime-ps1-fail-")), "capture.json"),
    [],
    {
      exitCode: 1,
      stderr:
        "npm.ps1 cannot be loaded because running scripts is disabled on this system. --token command-secret",
    },
  );
  const { eventRepo, manager, goal, close } = createManagedCodexHarness();
  const adapter = createCodexRuntimeAdapter({
    commandPath,
    modelLabel: "gpt-5-codex",
    probe: async () => ({ execJson: true, approvalResume: false }),
  });

  try {
    await manager.startManagedSession({
      goalId: goal.id,
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      prompt: "Fail on npm.ps1",
      adapter,
    });

    const failureMessage = eventRepo.listForGoal(goal.id).find((event) => event.type === "error")?.message ?? "";
    assert.match(failureMessage, /npm\.ps1/i);
    assert.match(failureMessage, /npm\.cmd/i);
    assert.equal(failureMessage.includes("command-secret"), false);
  } finally {
    close();
  }
});

test("reports unsupported Codex approval controls when resume is not verified", async () => {
  const adapter = createCodexRuntimeAdapter({
    commandPath: "C:\\Tools\\codex.exe",
    modelLabel: "gpt-5-codex",
    probe: async () => ({ execJson: true, approvalResume: false }),
    sessionRunner: async function* (): AsyncIterable<CodexJsonlParsedResult> {
      yield { observations: [] };
    },
  });
  const handle = await adapter.startSession({
    sessionId: "session-approval",
    goalId: "goal-approval",
    runId: "run-approval",
    prompt: "Need approval",
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
  });

  await assert.rejects(() => handle.approve("approval-1"), /approval resume is not supported/i);
  await assert.rejects(() => handle.reject("approval-1", "no"), /approval rejection is not supported/i);
});

test("cancels an active Codex runner and emits a terminal cancellation event", async () => {
  const adapter = createCodexRuntimeAdapter({
    commandPath: "C:\\Tools\\codex.exe",
    modelLabel: "gpt-5-codex",
    probe: async () => ({ execJson: true, approvalResume: false }),
    sessionRunner: async function* (input): AsyncIterable<CodexJsonlParsedResult> {
      yield {
        observations: [
          {
            kind: "progress",
            message: "Codex is running",
            metadata: { source: "jsonl", rawEventType: "turn.started" },
          },
        ],
      };
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  const handle = await adapter.startSession({
    sessionId: "session-cancel",
    goalId: "goal-cancel",
    runId: "run-cancel",
    prompt: "Cancel me",
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
  });
  const iterator = handle.events()[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.type, "session.started");
  assert.equal((await iterator.next()).value.type, "progress");
  await handle.cancel("stop");
  assert.equal((await iterator.next()).value.type, "session.cancelled");
  assert.equal((await iterator.next()).done, true);
});

function createManagedCodexHarness() {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-codex-runtime-harness-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Managed Codex process",
    description: "Exercise process-backed Codex adapter.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
  });

  return {
    goalRepo,
    eventRepo,
    manager,
    goal,
    close() {
      db.close();
    },
  };
}

function fakeCodexRuntimeProcess(
  capturePath: string,
  lines: string[],
  options: { exitCode?: number; stderr?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-agent-codex-runtime-process-"));
  const scriptPath = join(dir, "fake-codex-runtime.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
const lines = ${JSON.stringify(lines)};
const stderr = ${JSON.stringify(options.stderr ?? "")};
const exitCode = ${JSON.stringify(options.exitCode ?? 0)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));
  if (stderr) process.stderr.write(stderr);
  for (const line of lines) process.stdout.write(line + "\\n");
  process.exit(exitCode);
});
`,
  );
  chmodSync(scriptPath, 0o755);
  if (process.platform !== "win32") return scriptPath;
  const commandPath = join(dir, "fake-codex-runtime.cmd");
  writeFileSync(commandPath, `@echo off\r\n"${argv0}" "${scriptPath}" %*\r\n`);
  return commandPath;
}
