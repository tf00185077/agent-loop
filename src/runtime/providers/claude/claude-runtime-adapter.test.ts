import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeEvent } from "../../../domain/index.js";
import {
  buildClaudeManagedSessionArgs,
  createClaudeRuntimeAdapter,
  detectClaudeRuntimeCapabilities,
} from "./claude-runtime-adapter.js";

test("detects Claude managed runtime capabilities without true resume", async () => {
  const capabilities = await detectClaudeRuntimeCapabilities({
    commandPath: "C:\\Tools\\claude.cmd",
    probe: async () => ({ printMode: true }),
  });

  assert.deepEqual(capabilities, {
    eventStreaming: true,
    approval: false,
    cancellation: true,
    resume: false,
    childSessions: true,
    unsupportedReasons: {
      approval: "Claude print mode does not support backend-mediated approvals.",
      resume: "Claude true resume is not supported in v1; continuations restart with a fresh contract prompt.",
    },
  });
});

test("reports managed mode unsupported when the probe fails", async () => {
  const capabilities = await detectClaudeRuntimeCapabilities({
    commandPath: "C:\\Tools\\claude.cmd",
    probe: async () => ({ printMode: false, reason: "print mode unavailable" }),
  });

  assert.equal(capabilities.eventStreaming, false);
  assert.equal(capabilities.childSessions, false);
  assert.match(capabilities.unsupportedReasons?.approval ?? "", /print mode unavailable/);
});

test("builds Claude print args from the saved model label", () => {
  assert.deepEqual(buildClaudeManagedSessionArgs("claude-sonnet-4"), [
    "--print",
    "--output-format",
    "text",
    "--model",
    "claude-sonnet-4",
  ]);
  assert.deepEqual(buildClaudeManagedSessionArgs(null), ["--print", "--output-format", "text"]);
  assert.deepEqual(buildClaudeManagedSessionArgs("   "), ["--print", "--output-format", "text"]);
});

test("emits control metadata and stripped progress from Claude output", async () => {
  const delegationPayload = {
    type: "managed_delegation.request",
    role: "worker",
    taskId: "task-1",
    prompt: "Implement the lobby.",
    summary: "Implement the lobby.",
  };
  const prompts: string[] = [];
  const adapter = createClaudeRuntimeAdapter({
    commandPath: "C:\\Tools\\claude.cmd",
    modelLabel: "claude-sonnet-4",
    probe: async () => ({ printMode: true }),
    sessionRunner: async (input) => {
      prompts.push(input.prompt);
      return [
        "Delegating the first task.",
        "```auto-agent-control",
        JSON.stringify(delegationPayload),
        "```",
      ].join("\n");
    },
  });

  const handle = await adapter.startSession({
    sessionId: "session-claude",
    goalId: "goal-claude",
    runId: "run-claude",
    providerId: "claude-local",
    modelLabel: "claude-sonnet-4",
    prompt: "Supervise the goal.",
  });
  const events: AgentRuntimeEvent[] = [];
  for await (const event of handle.events()) events.push(event);

  assert.deepEqual(
    events.map((event) => event.type),
    ["session.started", "progress", "progress", "session.completed"],
  );
  assert.equal(events[1]?.message, "Delegating the first task.");
  assert.deepEqual(events[2]?.metadata?.delegationControlEvent, delegationPayload);
  assert.ok(!events.some((event) => event.message.includes("auto-agent-control")));
  assert.deepEqual(prompts, ["Supervise the goal."]);
});

test("maps runner failures into a sanitized failed session", async () => {
  const adapter = createClaudeRuntimeAdapter({
    commandPath: "C:\\Tools\\claude.cmd",
    modelLabel: null,
    probe: async () => ({ printMode: true }),
    sessionRunner: async () => {
      throw new Error("spawn failed --api-key sk-secret");
    },
  });

  const handle = await adapter.startSession({
    sessionId: "session-claude-fail",
    goalId: "goal-claude-fail",
    runId: "run-claude-fail",
    providerId: "claude-local",
    modelLabel: null,
    prompt: "Supervise.",
  });
  const events: AgentRuntimeEvent[] = [];
  for await (const event of handle.events()) events.push(event);

  assert.equal(events.at(-1)?.type, "session.failed");
  assert.ok(!JSON.stringify(events).includes("sk-secret"));
});

test("cancel terminates the session with a cancelled event", async () => {
  let release!: () => void;
  const blocked = new Promise<string>((resolve) => {
    release = () => resolve("late output");
  });
  const adapter = createClaudeRuntimeAdapter({
    commandPath: "C:\\Tools\\claude.cmd",
    modelLabel: null,
    probe: async () => ({ printMode: true }),
    sessionRunner: async (input) => {
      input.signal.addEventListener("abort", () => release(), { once: true });
      return blocked;
    },
  });

  const handle = await adapter.startSession({
    sessionId: "session-claude-cancel",
    goalId: "goal-claude-cancel",
    runId: "run-claude-cancel",
    providerId: "claude-local",
    modelLabel: null,
    prompt: "Supervise.",
  });
  const iterator = handle.events()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "session.started");
  await handle.cancel("User cancelled.");
  const next = await iterator.next();

  assert.equal(next.value.type, "session.cancelled");
  assert.equal((await iterator.next()).done, true);
});

test("throws when starting a session while managed mode is unsupported", async () => {
  const adapter = createClaudeRuntimeAdapter({
    commandPath: "C:\\Tools\\claude.cmd",
    modelLabel: null,
    probe: async () => ({ printMode: false, reason: "no print" }),
  });

  await assert.rejects(
    adapter.startSession({
      sessionId: "session-claude-unsupported",
      goalId: "goal-claude-unsupported",
      runId: "run-claude-unsupported",
      providerId: "claude-local",
      modelLabel: null,
      prompt: "Supervise.",
    }),
    /managed session/i,
  );
});
