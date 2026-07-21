import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeAdapter } from "../../domain/index.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createHandle, createManagerFixture, waitFor } from "./agent-session-test-harness.js";

/**
 * Per-goal workspace (specs/supervisor-goal-orchestration): a goal's supervisor
 * and workers run in the goal's workspace, falling back to the server default.
 */

/** Supervisor that dispatches one uncontracted worker; the worker fails fast. */
function workerDispatchAdapter(): AgentRuntimeAdapter {
  let supervisorStarted = false;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.failed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "worker done.", occurredAt: "2026-07-20T00:00:02.000Z",
          },
        ]);
      }
      if (supervisorStarted) return createHandle(input.sessionId, []);
      supervisorStarted = true;
      return createHandle(input.sessionId, [
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Requesting worker.", occurredAt: "2026-07-20T00:00:01.000Z",
          metadata: { delegationControlEvent: { type: "managed_delegation.request", role: "worker", prompt: "Do it.", summary: "Do it." } },
        },
      ]);
    },
  };
}

/** A worktree service that records the parentCwd each child worktree is created under. */
function recordingWorktreeService() {
  const parentCwds: string[] = [];
  return {
    parentCwds,
    async createChildWorktree(input: { parentCwd: string; childSessionId: string }) {
      parentCwds.push(input.parentCwd);
      return { path: `C:\\worktrees\\${input.childSessionId}`, label: `child-${input.childSessionId}` };
    },
    async removeWorktree() {},
  };
}

test("a goal's worker worktree is created under the goal's workspace", async () => {
  const fixture = createManagerFixture("workspace goal");
  const worktree = recordingWorktreeService();
  const goal = fixture.goalRepo.create({
    title: "Scoped goal", description: "runs elsewhere", workspace: "C:\\Users\\dev\\scratch-repo",
  });
  fixture.goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-20T00:00:00.000Z" });

  const manager = createAgentSessionManager({
    ...fixture, worktreeService: worktree, supervisorCwd: "C:\\server-default",
  });
  const result = await manager.startManagedSession({
    goalId: goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter: workerDispatchAdapter(),
  });
  await waitFor(() => worktree.parentCwds.length > 0);

  assert.equal(worktree.parentCwds[0], "C:\\Users\\dev\\scratch-repo");
  void result;
  fixture.db.close();
});

test("a goal with no workspace uses the server default", async () => {
  const fixture = createManagerFixture("default workspace goal");
  const worktree = recordingWorktreeService();
  // The harness goal has no workspace.
  const manager = createAgentSessionManager({
    ...fixture, worktreeService: worktree, supervisorCwd: "C:\\server-default",
  });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter: workerDispatchAdapter(),
  });
  await waitFor(() => worktree.parentCwds.length > 0);

  assert.equal(worktree.parentCwds[0], "C:\\server-default");
  fixture.db.close();
});
