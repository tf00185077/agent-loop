import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeSession } from "../../domain/index.js";
import {
  validateDelegationControlEvent,
  validateManagedControlEvent,
} from "./delegation-control-event.js";

test("accepts provider-neutral worker delegation control events", () => {
  const result = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Run the persistence tests and report the result.",
      summary: "Run persistence tests.",
    },
    parentSession: supervisorSession(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.request.role : null, "worker");
  assert.equal(result.ok ? result.request.promptSummary : null, "Run persistence tests.");
});

test("accepts supervisor review merge requests with a worker result reference", () => {
  const result = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "review_merge",
      prompt: "Review and merge the worker output.",
      summary: "Review worker output.",
      workerDelegationRequestId: "delegation-worker-1",
    },
    parentSession: supervisorSession(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.request.role : null, "review_merge");
  assert.equal(result.ok ? result.request.workerDelegationRequestId : null, "delegation-worker-1");
});

test("rejects malformed unauthorized or nested delegation control events", () => {
  const invalidRole = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "reviewer",
      prompt: "Review these changes.",
    },
    parentSession: supervisorSession(),
  });
  const nested = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Start another child.",
    },
    parentSession: supervisorSession({ parent: { sessionId: "supervisor-session" } }),
  });
  const malformed = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
    },
    parentSession: supervisorSession(),
  });
  const missingWorkerResult = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "review_merge",
      prompt: "Review these changes.",
    },
    parentSession: supervisorSession(),
  });

  assert.deepEqual(invalidRole, { ok: false, safeReason: "Unsupported delegation role: reviewer." });
  assert.deepEqual(nested, { ok: false, safeReason: "Maximum delegation depth reached." });
  assert.deepEqual(malformed, { ok: false, safeReason: "Delegation prompt must be a non-empty string." });
  assert.deepEqual(missingWorkerResult, {
    ok: false,
    safeReason: "Review merge requires a worker delegation result reference.",
  });
});

test("accepts delegation requests with an optional task id", () => {
  const result = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Implement task two.",
      summary: "Implement task two.",
      taskId: "task-2",
    },
    parentSession: supervisorSession(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.request.taskId : null, "task-2");
});

test("treats blank task ids as absent", () => {
  const result = validateDelegationControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Implement task two.",
      taskId: "   ",
    },
    parentSession: supervisorSession(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.request.taskId : "unexpected", null);
});

test("validates completion control events through the managed umbrella", () => {
  const valid = validateManagedControlEvent({
    controlEvent: { type: "managed_delegation.complete", summary: "Goal delivered." },
    parentSession: supervisorSession(),
  });
  const missingSummary = validateManagedControlEvent({
    controlEvent: { type: "managed_delegation.complete" },
    parentSession: supervisorSession(),
  });

  assert.deepEqual(valid, { ok: true, kind: "completion", summary: "Goal delivered." });
  assert.deepEqual(missingSummary, {
    ok: false,
    safeReason: "Completion summary must be a non-empty string.",
  });
});

test("validates task list control events through the managed umbrella", () => {
  const valid = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.task_list",
      tasks: [
        { id: "task-1", title: "Set up module" },
        { id: "task-2", title: "Implement feature" },
      ],
    },
    parentSession: supervisorSession(),
  });
  const empty = validateManagedControlEvent({
    controlEvent: { type: "managed_delegation.task_list", tasks: [] },
    parentSession: supervisorSession(),
  });
  const malformed = validateManagedControlEvent({
    controlEvent: { type: "managed_delegation.task_list", tasks: [{ id: "task-1" }] },
    parentSession: supervisorSession(),
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.ok && valid.kind === "task_list" ? valid.tasks.length : 0, 2);
  assert.deepEqual(empty, { ok: false, safeReason: "Task list must contain at least one task." });
  assert.deepEqual(malformed, {
    ok: false,
    safeReason: "Task list entries require non-empty id and title strings.",
  });
});

test("routes delegation requests through the managed umbrella", () => {
  const result = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Implement task one.",
      taskId: "task-1",
    },
    parentSession: supervisorSession(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.kind : null, "delegation");
  assert.equal(result.ok && result.kind === "delegation" ? result.request.taskId : null, "task-1");
});

test("rejects unknown managed control event types with a safe reason", () => {
  const result = validateManagedControlEvent({
    controlEvent: { type: "managed_delegation.pause" },
    parentSession: supervisorSession(),
  });

  assert.deepEqual(result, {
    ok: false,
    safeReason: "Unsupported control event type: managed_delegation.pause.",
  });
});

function supervisorSession(overrides: Partial<AgentRuntimeSession> = {}): AgentRuntimeSession {
  return {
    id: "session-supervisor",
    goalId: "goal-1",
    runId: "run-1",
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "running",
    capabilities: {
      eventStreaming: true,
      approval: false,
      cancellation: true,
      resume: false,
      childSessions: true,
    },
    parent: null,
    createdAt: "2026-07-03T00:00:00.000Z",
    lastActivityAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}
