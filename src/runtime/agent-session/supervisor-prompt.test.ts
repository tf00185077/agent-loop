import assert from "node:assert/strict";
import test from "node:test";

import { buildSupervisorPrompt } from "./supervisor-prompt.js";

const goal = {
  title: "Build a shooter game",
  description: "4v4 competitive and co-op modes are required.",
};

const contractSections = [
  // Role framing.
  "You are the supervisor",
  // Decompose-first instruction.
  "task list",
  "managed_delegation.task_list",
  // One worker at a time rule.
  "one worker",
  // Review merge instruction.
  "review_merge",
  "managed_delegation.request",
  // Completion signal.
  "managed_delegation.complete",
  // Only fenced blocks are honored.
  "auto-agent-control",
];

test("bootstrap prompt carries goal context and the full control contract", () => {
  const prompt = buildSupervisorPrompt({ goal, phase: { kind: "bootstrap" } });

  assert.ok(prompt.includes(goal.title));
  assert.ok(prompt.includes(goal.description));
  for (const section of contractSections) {
    assert.ok(prompt.includes(section), `bootstrap prompt missing: ${section}`);
  }
});

test("bootstrap prompt includes one fenced example per control block type", () => {
  const prompt = buildSupervisorPrompt({ goal, phase: { kind: "bootstrap" } });

  const fences = prompt.match(/```auto-agent-control/g) ?? [];
  assert.ok(fences.length >= 3, `expected at least 3 control block examples, got ${fences.length}`);
});

test("continuation prompt carries the child observation and the full contract", () => {
  const prompt = buildSupervisorPrompt({
    goal,
    phase: { kind: "continuation", observation: "Worker finished the matchmaking module." },
  });

  assert.ok(prompt.includes("Worker result: Worker finished the matchmaking module."));
  assert.ok(prompt.includes(goal.title));
  for (const section of contractSections) {
    assert.ok(prompt.includes(section), `continuation prompt missing: ${section}`);
  }
});

test("nudge prompt asks the supervisor to continue or complete", () => {
  const prompt = buildSupervisorPrompt({ goal, phase: { kind: "nudge" } });

  assert.ok(/continue or complete/i.test(prompt));
  assert.ok(prompt.includes("managed_delegation.complete"));
});

test("rejection prompt carries the safe rejection reason", () => {
  const prompt = buildSupervisorPrompt({
    goal,
    phase: { kind: "rejection", safeReason: "Completion summary must be a non-empty string." },
  });

  assert.ok(prompt.includes("Completion summary must be a non-empty string."));
  assert.ok(prompt.includes("auto-agent-control"));
});
