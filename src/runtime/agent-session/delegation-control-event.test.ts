import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeSession } from "../../domain/index.js";
import { validateDelegationControlEvent } from "./delegation-control-event.js";

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

  assert.deepEqual(invalidRole, { ok: false, safeReason: "Unsupported delegation role: reviewer." });
  assert.deepEqual(nested, { ok: false, safeReason: "Maximum delegation depth reached." });
  assert.deepEqual(malformed, { ok: false, safeReason: "Delegation prompt must be a non-empty string." });
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
