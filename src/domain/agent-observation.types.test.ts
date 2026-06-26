import assert from "node:assert/strict";
import test from "node:test";

import {
  agentObservationEventTypes,
  createAgentObservationEventInput,
  type AgentObservation,
} from "./agent-observation.types.js";

test("creates durable event input for command observations with safe execution metadata", () => {
  const observation: AgentObservation = {
    kind: "command.completed",
    message: "Command completed",
    command: {
      label: "npm test",
      status: "completed",
      exitCode: 0,
      stdoutTail: "17 tests passed",
      stderrTail: "",
    },
    metadata: {
      provider: "codex-cli",
      model: "gpt-5-codex",
      agentRole: "main",
      agentId: "agent-main",
      parentAgentId: "agent-parent",
      taskId: "task-1",
      source: "jsonl",
      rawEventType: "exec_command_end",
    },
  };

  const eventInput = createAgentObservationEventInput({
    goalId: "goal-1",
    runId: "run-1",
    stepId: "step-1",
    observation,
  });

  assert.equal(eventInput.type, "agent.command.completed");
  assert.equal(eventInput.message, "Command completed");
  assert.deepEqual(eventInput.data, {
    observationKind: "command.completed",
    provider: "codex-cli",
    model: "gpt-5-codex",
    agentRole: "main",
    agentId: "agent-main",
    parentAgentId: "agent-parent",
    taskId: "task-1",
    source: "jsonl",
    rawEventType: "exec_command_end",
    command: {
      label: "npm test",
      status: "completed",
      exitCode: 0,
      stdoutTail: "17 tests passed",
    },
  });
});

test("supports heartbeat progress command failure and subtask observation event types", () => {
  assert.deepEqual(agentObservationEventTypes, [
    "agent.heartbeat",
    "agent.progress",
    "agent.command.started",
    "agent.command.completed",
    "agent.command.failed",
    "agent.subtask.started",
    "agent.subtask.completed",
    "agent.subtask.failed",
  ]);
});
