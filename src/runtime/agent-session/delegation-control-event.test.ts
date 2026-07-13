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

test("validates acceptance criteria on task lists and delegation requests", () => {
  const validList = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.task_list",
      tasks: [
        {
          id: "task-1",
          title: "Implement matchmaking",
          acceptance: [
            { id: "A1", text: "Two players can join the same lobby." },
            { id: "A2", text: "Lobby rejects a third player." },
          ],
        },
        { id: "task-2", title: "Docs only" },
      ],
    },
    parentSession: supervisorSession(),
  });
  const duplicateIds = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.task_list",
      tasks: [
        {
          id: "task-1",
          title: "Implement matchmaking",
          acceptance: [
            { id: "A1", text: "First." },
            { id: "A1", text: "Duplicate id." },
          ],
        },
      ],
    },
    parentSession: supervisorSession(),
  });
  const blankText = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.task_list",
      tasks: [{ id: "task-1", title: "t", acceptance: [{ id: "A1", text: "  " }] }],
    },
    parentSession: supervisorSession(),
  });
  const requestWithAcceptance = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Do task one.",
      taskId: "task-1",
      acceptance: [{ id: "A1", text: "Two players can join the same lobby." }],
    },
    parentSession: supervisorSession(),
  });

  assert.equal(validList.ok, true);
  assert.deepEqual(
    validList.ok && validList.kind === "task_list" ? validList.tasks[0]?.acceptance : null,
    [
      { id: "A1", text: "Two players can join the same lobby." },
      { id: "A2", text: "Lobby rejects a third player." },
    ],
  );
  assert.equal(
    validList.ok && validList.kind === "task_list" ? validList.tasks[1]?.acceptance : "x",
    null,
  );
  assert.deepEqual(duplicateIds, {
    ok: false,
    safeReason: "Acceptance criterion ids must be unique within a task.",
  });
  assert.deepEqual(blankText, {
    ok: false,
    safeReason: "Acceptance criteria require non-empty id and text strings.",
  });
  assert.equal(requestWithAcceptance.ok, true);
  assert.deepEqual(
    requestWithAcceptance.ok && requestWithAcceptance.kind === "delegation"
      ? requestWithAcceptance.request.acceptance
      : null,
    [{ id: "A1", text: "Two players can join the same lobby." }],
  );
});

test("validates managed task result control events", () => {
  const valid = validateManagedControlEvent({
    controlEvent: {
      type: "managed_task.result",
      taskId: "task-1",
      criterionEvidence: [{ criterionId: "A1", evidence: "Joined two players in test lobby." }],
      tests: [{ command: "npm test -- lobby", exitCode: 0, summary: "3 passing" }],
      claimedFiles: ["src/lobby.ts"],
    },
    parentSession: supervisorSession(),
  });
  const malformedEvidence = validateManagedControlEvent({
    controlEvent: {
      type: "managed_task.result",
      criterionEvidence: [{ criterionId: "A1" }],
    },
    parentSession: supervisorSession(),
  });
  const minimal = validateManagedControlEvent({
    controlEvent: { type: "managed_task.result" },
    parentSession: supervisorSession(),
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.ok ? valid.kind : null, "task_result");
  assert.deepEqual(
    valid.ok && valid.kind === "task_result" ? valid.result.criterionEvidence : null,
    [{ criterionId: "A1", evidence: "Joined two players in test lobby." }],
  );
  assert.deepEqual(malformedEvidence, {
    ok: false,
    safeReason: "Criterion evidence entries require non-empty criterionId and evidence strings.",
  });
  assert.equal(minimal.ok, true);
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
