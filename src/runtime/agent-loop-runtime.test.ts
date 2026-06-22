import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../persistence/database.js";
import { createGoalRepository } from "../persistence/goal-repository.js";
import {
  createEventRepository,
  createRunRepository,
  createStepRepository,
} from "../persistence/runtime-repositories.js";
import { createAgentLoopRuntime } from "./agent-loop-runtime.js";

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "auto-agent-loop-runtime-")), "runtime.sqlite");
  const db = openDatabase({ path });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const stepRepo = createStepRepository(db);
  const eventRepo = createEventRepository(db);
  return { db, goalRepo, runRepo, stepRepo, eventRepo };
}

test("agent loop persists planner decision and closes a direct step without a gate vote", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Ship the loop",
    description: "Plan, implement, and gate one direct step",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    planner: {
      async plan(input) {
        assert.equal(input.goal.id, goal.id);
        assert.deepEqual(input.priorSteps, []);
        return {
          decision: "IMPLEMENT_DIRECTLY",
          nextStep: "Write the first loop step",
          reason: "Small enough to do directly",
        };
      },
    },
    implementer: {
      async implement(input) {
        assert.equal(input.goal.id, goal.id);
        assert.equal(input.step, "Write the first loop step");
        return {
          step: input.step,
          result: "Implemented the first loop step",
        };
      },
    },
    gate: {
      async vote() {
        throw new Error("Gate should not run for direct implementation");
      },
    },
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "step.started",
      "agent.decision",
      "agent.message",
      "step.completed",
      "run.completed",
      "goal.completed",
    ],
  );
  const runId = events[0]?.runId;
  assert.ok(runId);
  assert.equal(runRepo.getById(runId)?.status, "completed");
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  const steps = stepRepo.listForRun(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.status, "completed");
  assert.equal(steps[0]?.result, "Implemented the first loop step");

  const decision = events.find((event) => event.type === "agent.decision");
  assert.deepEqual(decision?.data, {
    decision: "IMPLEMENT_DIRECTLY",
    nextStep: "Write the first loop step",
    reason: "Small enough to do directly",
  });

  const message = events.find((event) => event.type === "agent.message");
  assert.equal(message?.message, "Implemented the first loop step");
  assert.deepEqual(message?.data, {
    stepId: message?.stepId,
    role: "implementer",
    step: "Write the first loop step",
  });

  assert.equal(events.some((event) => event.type === "gate.voted"), false);
  assert.equal(events.some((event) => event.type === "scope.voted"), false);

  db.close();
});

test("agent loop stops decomposition at maxDepth and records a bounded terminal state", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Respect depth bounds",
    description: "Do not decompose past the configured depth",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    maxSteps: 3,
    maxDepth: 0,
    planner: {
      async plan() {
        return {
          decision: "DECOMPOSE",
          subSteps: ["First child step"],
          reason: "Needs a child step",
        };
      },
    },
    implementer: {
      async implement() {
        throw new Error("Implementer should not run when decomposition is bounded");
      },
    },
    gate: {
      async vote() {
        throw new Error("Gate should not run when decomposition is bounded");
      },
    },
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const runId = events[0]?.runId;
  assert.ok(runId);
  assert.equal(stepRepo.listForRun(runId).length, 0);
  assert.equal(events.some((event) => event.type === "agent.decision"), true);
  assert.equal(runRepo.getById(runId)?.status, "completed");
  assert.equal(goalRepo.getById(goal.id)?.status, "blocked");
  assert.deepEqual(events.at(-1)?.data, {
    goalId: goal.id,
    runId,
    terminalState: "bounded",
    bound: "maxDepth",
    maxDepth: 0,
  });

  db.close();
});

test("agent loop runs a scope vote after the scope assessment attempt limit", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Refine broad scope",
    description: "Ask voters after repeated broad assessments",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });
  let plannerCalls = 0;
  let scopeVoteCalls = 0;

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    maxScopeAssessmentAttempts: 2,
    maxScopeRefinementRounds: 1,
    planner: {
      async plan() {
        plannerCalls += 1;
        return {
          decision: "DECOMPOSE",
          scopeAssessment: "too_large",
          subSteps: ["Narrow runtime scope"],
          reason: `Too broad attempt ${plannerCalls}`,
        };
      },
    },
    implementer: {
      async implement() {
        throw new Error("Implementer should not run before scope is accepted");
      },
    },
    gate: {
      async vote() {
        throw new Error("Completion gate should not run for scope assessment");
      },
    },
    scopeGate: {
      async vote(input) {
        scopeVoteCalls += 1;
        assert.equal(input.assessmentAttempt, 2);
        assert.equal(input.refinementRound, 0);
        assert.equal(input.decision.reason, "Too broad attempt 2");
        return {
          proposition: "Is the current task still too large?",
          decision: true,
          shouldRefine: true,
          tally: {
            refine: 2,
            proceed: 1,
            total: 3,
            majorityReached: true,
          },
          ballots: [],
        };
      },
    },
  });

  await runtime.run(goal.id);

  assert.equal(plannerCalls, 2);
  assert.equal(scopeVoteCalls, 1);
  assert.equal(stepRepo.listForRun(eventRepo.listForGoal(goal.id)[0]?.runId ?? "").length, 0);

  db.close();
});

test("agent loop carries planner and voter reasons into the next refinement round", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Carry refinement context",
    description: "Avoid repeating the same broad decomposition",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });
  const observedContexts: unknown[] = [];

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    maxScopeAssessmentAttempts: 1,
    maxScopeRefinementRounds: 2,
    planner: {
      async plan(input) {
        observedContexts.push(input.scopeRefinementContext ?? null);
        if (observedContexts.length === 1) {
          return {
            decision: "DECOMPOSE",
            scopeAssessment: "too_large",
            subSteps: ["Split runtime changes"],
            reason: "The runtime and voter work are bundled together.",
          };
        }
        return {
          decision: "IMPLEMENT_DIRECTLY",
          nextStep: "Implement only the runtime transition",
          reason: "The scope is now narrow enough.",
        };
      },
    },
    implementer: {
      async implement(input) {
        return {
          step: input.step,
          result: "Implemented the runtime transition",
        };
      },
    },
    gate: {
      async vote() {
        throw new Error("Completion gate should not run for direct implementation");
      },
    },
    scopeGate: {
      async vote() {
        return {
          proposition: "Is the current task still too large?",
          decision: true,
          shouldRefine: true,
          tally: {
            refine: 2,
            proceed: 1,
            total: 3,
            majorityReached: true,
          },
          ballots: [
            {
              voterId: "codex-local",
              providerKind: "codex-local",
              decision: true,
              reason: "Keep only the runtime transition in the next round.",
            },
          ],
        };
      },
    },
  });

  await runtime.run(goal.id);

  assert.deepEqual(observedContexts, [
    null,
    {
      assessmentAttempt: 0,
      refinementRound: 1,
      previousPlannerReason: "The runtime and voter work are bundled together.",
      previousVoterReason: "Keep only the runtime transition in the next round.",
    },
  ]);
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  db.close();
});

test("agent loop records a blocked terminal state when the planner blocks", async () => {
  const { db, goalRepo, runRepo, stepRepo, eventRepo } = setup();
  const goal = goalRepo.create({
    title: "Ask for human input",
    description: "Planner cannot proceed safely",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: new Date().toISOString() });

  const runtime = createAgentLoopRuntime({
    goalRepo,
    runRepo,
    stepRepo,
    eventRepo,
    metadata: { provider: "fake-loop", model: "fake-model" },
    planner: {
      async plan() {
        return {
          decision: "BLOCKED",
          reason: "Need the user to choose the deployment target",
        };
      },
    },
    implementer: {
      async implement() {
        throw new Error("Implementer should not run for blocked planner decisions");
      },
    },
    gate: {
      async vote() {
        throw new Error("Gate should not run for blocked planner decisions");
      },
    },
  });

  await runtime.run(goal.id);

  const events = eventRepo.listForGoal(goal.id);
  const runId = events[0]?.runId;
  assert.ok(runId);
  assert.equal(stepRepo.listForRun(runId).length, 0);
  assert.equal(runRepo.getById(runId)?.status, "completed");
  assert.equal(goalRepo.getById(goal.id)?.status, "blocked");
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "agent.decision", "run.completed", "goal.blocked"],
  );
  assert.deepEqual(events.at(-1)?.data, {
    goalId: goal.id,
    runId,
    terminalState: "blocked",
    reason: "Need the user to choose the deployment target",
  });

  db.close();
});
