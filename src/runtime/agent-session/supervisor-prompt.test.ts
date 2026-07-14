import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSupervisorPrompt,
  buildWorkerContractAppendix,
  buildJudgeContractAppendix,
  renderChangeHistory,
  renderTaskHistory,
} from "./supervisor-prompt.js";

test("judge appendix requires exact criterion decisions and denies commit authority", () => {
  const prompt = buildJudgeContractAppendix({
    workerDelegationRequestId: "worker-1",
    acceptance: [{ id: "A1", text: "Tests pass" }],
    resultSummary: { kind: "success", safeSummary: "Claim", attestedFiles: ["src/a.ts"] },
  });
  assert.match(prompt, /managed_review\.decision/);
  assert.match(prompt, /worker-1/);
  assert.match(prompt, /A1: Tests pass/);
  assert.match(prompt, /no apply or commit authority/i);
});
import type { ChangeRecord } from "./change-registry.js";
import type { TaskRecord } from "./task-registry.js";

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

test("bootstrap prompt documents the acceptance-contract rules", () => {
  const prompt = buildSupervisorPrompt({ goal, phase: { kind: "bootstrap" } });

  assert.ok(prompt.includes("acceptance criteria"));
  assert.ok(/frozen/i.test(prompt));
  assert.ok(/cite/i.test(prompt));
  assert.ok(/deferred findings/i.test(prompt));
  assert.ok(/parentTaskId/.test(prompt));
  assert.ok(prompt.includes('"acceptance"'), "task_list example must show acceptance criteria");
});

const historyFixture: TaskRecord[] = [
  {
    id: "task-1",
    title: "Lobby join",
    acceptance: [
      { id: "A1", text: "Second player can join." },
      { id: "A2", text: "Third player is rejected." },
    ],
    status: "split",
    attemptCount: 2,
    substantiveRejections: 2,
    lastCitedCriteria: ["A1"],
    criterionOutcomes: { A1: "failed", A2: "passed" },
    parentTaskId: null,
    lastOutcomeSummary: "Worker claims done.",
  },
  {
    id: "task-1a",
    title: "Second player join only",
    acceptance: [{ id: "A1", text: "Second player can join." }],
    status: "pending",
    attemptCount: 0,
    substantiveRejections: 0,
    lastCitedCriteria: [],
    criterionOutcomes: { A1: "unknown" },
    parentTaskId: "task-1",
    lastOutcomeSummary: null,
  },
];

test("task history renders statuses criterion outcomes rejections and lineage", () => {
  const history = renderTaskHistory(historyFixture);

  assert.ok(history.includes('task-1 "Lobby join" [split] attempts=2, rejections=2 citing [A1]'));
  assert.ok(history.includes("A1: failed, A2: passed"));
  assert.ok(history.includes('task-1a "Second player join only" (split from task-1) [pending]'));
  assert.ok(history.includes("last: Worker claims done."));
});

test("continuation and nudge prompts carry the task history when present", () => {
  const continuation = buildSupervisorPrompt({
    goal,
    phase: { kind: "continuation", observation: "Worker finished." },
    taskHistory: historyFixture,
  });
  const nudge = buildSupervisorPrompt({ goal, phase: { kind: "nudge" }, taskHistory: historyFixture });
  const bootstrap = buildSupervisorPrompt({ goal, phase: { kind: "bootstrap" }, taskHistory: historyFixture });

  assert.ok(continuation.includes("## Task history"));
  assert.ok(nudge.includes("## Task history"));
  assert.ok(!bootstrap.includes("## Task history"));
});

test("worker contract appendix lists criteria and the result-block format", () => {
  const appendix = buildWorkerContractAppendix(
    [
      { id: "A1", text: "Second player can join." },
      { id: "A2", text: "Third player is rejected." },
    ],
    "task-1",
  );

  assert.ok(appendix.includes("- A1: Second player can join."));
  assert.ok(appendix.includes("- A2: Third player is rejected."));
  assert.ok(appendix.includes("managed_task.result"));
  assert.ok(appendix.includes('"taskId": "task-1"'));
  assert.ok(appendix.includes("auto-agent-control"));
});

test("bootstrap prompt documents goal scale assessment and the change plan format", () => {
  const prompt = buildSupervisorPrompt({ goal, phase: { kind: "bootstrap" } });

  assert.ok(/scale/i.test(prompt), "bootstrap must document scale assessment");
  assert.ok(prompt.includes("managed_change.plan"));
  assert.ok(/2–8|2-8|between 2 and 8/i.test(prompt), "bootstrap must state the plan budget");
  assert.ok(/dependsOn/.test(prompt), "plan example must show dependencies");
  assert.ok(/"rationale"/.test(prompt), "plan example must show a rationale");
  assert.ok(/small goals?/i.test(prompt), "bootstrap must keep small goals on the flat flow");
  assert.ok(/spec:/.test(prompt), "bootstrap must explain the backend-registered spec tasks");
});

const changeHistoryFixture: ChangeRecord[] = [
  {
    id: "change-one",
    title: "Change one",
    rationale: "First slice.",
    dependsOn: [],
    status: "archived",
    taskIds: ["spec:change-one", "task-1"],
    hasUnmergedAttestedChanges: false,
  },
  {
    id: "change-two",
    title: "Change two",
    rationale: "Second slice.",
    dependsOn: ["change-one"],
    status: "executing",
    taskIds: ["spec:change-two"],
    hasUnmergedAttestedChanges: false,
  },
  {
    id: "change-three",
    title: "Change three",
    rationale: "Third slice.",
    dependsOn: [],
    status: "planned",
    taskIds: ["spec:change-three"],
    hasUnmergedAttestedChanges: false,
  },
];

test("change history renders plan statuses and marks the active change", () => {
  const history = renderChangeHistory(changeHistoryFixture);

  assert.ok(history.includes('change-one "Change one" [archived]'));
  assert.match(history, /change-two "Change two" \[executing\].*\(active/);
  assert.ok(history.includes("(depends on change-one)"));
  assert.ok(history.includes('change-three "Change three" [planned]'));
  assert.doesNotMatch(history, /change-one "Change one" \[archived\].*\(active/);
  assert.doesNotMatch(history, /change-three "Change three" \[planned\].*\(active/);
});

test("continuation and nudge prompts carry the change history when a plan exists", () => {
  const continuation = buildSupervisorPrompt({
    goal,
    phase: { kind: "continuation", observation: "Worker finished." },
    changeHistory: changeHistoryFixture,
  });
  const nudge = buildSupervisorPrompt({ goal, phase: { kind: "nudge" }, changeHistory: changeHistoryFixture });

  assert.ok(continuation.includes("## Change plan"));
  assert.ok(nudge.includes("## Change plan"));
  assert.ok(continuation.includes("change-two"));
});

test("plan-less goals render without a change plan section", () => {
  const continuation = buildSupervisorPrompt({
    goal,
    phase: { kind: "continuation", observation: "Worker finished." },
    taskHistory: historyFixture,
    changeHistory: [],
  });
  const nudge = buildSupervisorPrompt({ goal, phase: { kind: "nudge" } });

  assert.ok(!continuation.includes("## Change plan"));
  assert.ok(!nudge.includes("## Change plan"));
});

test("rejection prompt carries the safe rejection reason", () => {
  const prompt = buildSupervisorPrompt({
    goal,
    phase: { kind: "rejection", safeReason: "Completion summary must be a non-empty string." },
  });

  assert.ok(prompt.includes("Completion summary must be a non-empty string."));
  assert.ok(prompt.includes("auto-agent-control"));
});
