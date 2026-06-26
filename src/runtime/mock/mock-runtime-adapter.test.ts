import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeEvent } from "../../domain/index.js";
import { createMockRuntimeAdapter } from "./mock-runtime-adapter.js";

test("mock runtime adapter emits progress command approval child-session and completion events", async () => {
  const adapter = createMockRuntimeAdapter();
  const capabilities = await adapter.detectCapabilities();

  assert.deepEqual(capabilities, {
    eventStreaming: true,
    approval: true,
    cancellation: true,
    resume: false,
    childSessions: true,
  });

  const handle = await adapter.startSession({
    sessionId: "session-1",
    goalId: "goal-1",
    runId: "run-1",
    prompt: "Exercise the mock control plane.",
    providerId: "mock",
    modelLabel: "mock-v1",
  });

  const events = await collectEvents(handle.events());

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "session.started",
      "progress",
      "command.started",
      "approval.requested",
      "child_session.requested",
      "command.completed",
      "session.completed",
    ],
  );
  assert.equal(events[0]?.sessionId, "session-1");
  assert.equal(events[0]?.goalId, "goal-1");
  assert.equal(events[0]?.runId, "run-1");
  assert.equal(events[0]?.metadata?.providerId, "mock");
  assert.equal(events[0]?.metadata?.modelLabel, "mock-v1");
  assert.equal(events[2]?.metadata?.commandId, "mock-command-1");
  assert.equal(events[3]?.metadata?.approvalRequestId, "mock-approval-1");
  assert.equal(events[3]?.metadata?.commandId, "mock-command-1");
  assert.equal(events[4]?.metadata?.childSessionRequestId, "mock-child-session-1");
});

test("mock runtime adapter can emit a deterministic failure sequence", async () => {
  const adapter = createMockRuntimeAdapter({ outcome: "failed" });
  const handle = await adapter.startSession({
    sessionId: "session-2",
    goalId: "goal-2",
    runId: "run-2",
    prompt: "Fail deterministically.",
    providerId: "mock",
    modelLabel: "mock-v1",
  });

  const events = await collectEvents(handle.events());

  assert.deepEqual(
    events.map((event) => event.type),
    ["session.started", "progress", "command.started", "command.failed", "session.failed"],
  );
  assert.match(events.at(-1)?.message ?? "", /failed/i);
});

test("mock runtime adapter emits cancellation after cancel is requested", async () => {
  const adapter = createMockRuntimeAdapter({ pauseBeforeTerminal: true });
  const handle = await adapter.startSession({
    sessionId: "session-3",
    goalId: "goal-3",
    runId: "run-3",
    prompt: "Cancel deterministically.",
    providerId: "mock",
    modelLabel: "mock-v1",
  });

  const iterator = handle.events()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "session.started");
  assert.equal((await iterator.next()).value.type, "progress");

  await handle.cancel("No longer needed.");
  const cancelled = await iterator.next();

  assert.equal(cancelled.value.type, "session.cancelled");
  assert.equal(cancelled.value.message, "Mock session cancelled: No longer needed.");
  assert.equal((await iterator.next()).done, true);
});

async function collectEvents(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
