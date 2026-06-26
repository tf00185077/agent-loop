import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
