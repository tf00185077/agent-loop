import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionLifecycleState, GoalStatus } from "../../domain/index.js";
import { recordUnhandledRuntimeFailure, type UnhandledFailureDeps } from "./unhandled-failure.js";

interface EventCall {
  goalId: string;
  runId?: string | null;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

function createDeps(options: {
  goalStatus?: GoalStatus;
  sessionState?: AgentSessionLifecycleState;
  throwOnEvent?: boolean;
} = {}): {
  deps: UnhandledFailureDeps;
  events: EventCall[];
  goalStatusUpdates: Array<{ id: string; status: GoalStatus }>;
  sessionStateUpdates: Array<{ id: string; state: AgentSessionLifecycleState }>;
} {
  const events: EventCall[] = [];
  const goalStatusUpdates: Array<{ id: string; status: GoalStatus }> = [];
  const sessionStateUpdates: Array<{ id: string; state: AgentSessionLifecycleState }> = [];
  let goalStatus: GoalStatus = options.goalStatus ?? "running";
  let sessionState: AgentSessionLifecycleState = options.sessionState ?? "running";

  const deps: UnhandledFailureDeps = {
    goalRepo: {
      getById(id) {
        return { id, status: goalStatus } as never;
      },
      updateStatus(id, status) {
        goalStatus = status;
        goalStatusUpdates.push({ id, status });
        return { id, status } as never;
      },
    },
    eventRepo: {
      create(input) {
        if (options.throwOnEvent) throw new Error("event write failed");
        events.push(input as EventCall);
        return input as never;
      },
    },
    agentSessionRepo: {
      getSession(id) {
        return { id, lifecycleState: sessionState } as never;
      },
      updateLifecycleState(id, state) {
        sessionState = state;
        sessionStateUpdates.push({ id, state });
        return { id, lifecycleState: state } as never;
      },
    },
  };

  return { deps, events, goalStatusUpdates, sessionStateUpdates };
}

test("goal failure on a non-terminal goal records a durable error event and fails the goal", () => {
  const { deps, events, goalStatusUpdates } = createDeps({ goalStatus: "running" });

  recordUnhandledRuntimeFailure(deps, { kind: "goal", goalId: "goal-1", error: new Error("boom") });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "error");
  assert.equal(events[0]!.goalId, "goal-1");
  assert.deepEqual(goalStatusUpdates, [{ id: "goal-1", status: "failed" }]);
});

for (const terminal of ["completed", "failed", "blocked", "cancelled"] as const) {
  test(`goal failure is a no-op when the goal is already ${terminal}`, () => {
    const { deps, events, goalStatusUpdates } = createDeps({ goalStatus: terminal });

    recordUnhandledRuntimeFailure(deps, { kind: "goal", goalId: "goal-1", error: new Error("boom") });

    assert.equal(events.length, 0);
    assert.deepEqual(goalStatusUpdates, []);
  });
}

test("the helper never throws even if the durable write fails", () => {
  const { deps } = createDeps({ goalStatus: "running", throwOnEvent: true });

  assert.doesNotThrow(() =>
    recordUnhandledRuntimeFailure(deps, { kind: "goal", goalId: "goal-1", error: new Error("boom") }),
  );
});

test("delegation failure records an error event scoped to the delegation and child session", () => {
  const { deps, events, sessionStateUpdates } = createDeps({ sessionState: "running" });

  recordUnhandledRuntimeFailure(deps, {
    kind: "delegation",
    goalId: "goal-1",
    runId: "run-1",
    delegationRequestId: "del-1",
    childSessionId: "sess-1",
    error: new Error("child loop exploded"),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "error");
  assert.equal(events[0]!.goalId, "goal-1");
  assert.equal(events[0]!.data?.delegationRequestId, "del-1");
  assert.equal(events[0]!.data?.childSessionId, "sess-1");
  assert.deepEqual(sessionStateUpdates, [{ id: "sess-1", state: "failed" }]);
});

for (const terminal of ["completed", "failed", "cancelled"] as const) {
  test(`delegation failure does not re-mark a child session already ${terminal}`, () => {
    const { deps, sessionStateUpdates } = createDeps({ sessionState: terminal });

    recordUnhandledRuntimeFailure(deps, {
      kind: "delegation",
      goalId: "goal-1",
      runId: "run-1",
      delegationRequestId: "del-1",
      childSessionId: "sess-1",
      error: new Error("child loop exploded"),
    });

    assert.deepEqual(sessionStateUpdates, []);
  });
}
