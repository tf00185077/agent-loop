import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeSession } from "../../domain/index.js";
import {
  validateDelegationControlEvent,
  validateManagedControlEvent,
  validateManagedReviewDecision,
  validateManagedIntegrationResult,
  selectManagedIntegrationResult,
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

test("validates change plans with budgets and acyclic dependencies", () => {
  const valid = validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.plan",
      changes: [
        { id: "change-core", title: "Core loop", rationale: "Foundation for both modes." },
        {
          id: "change-4v4",
          title: "4v4 mode",
          rationale: "Competitive mode.",
          dependsOn: ["change-core"],
        },
      ],
    },
    parentSession: supervisorSession(),
  });
  const single = validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.plan",
      changes: [{ id: "only", title: "One", rationale: "r" }],
    },
    parentSession: supervisorSession(),
  });
  const empty = validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.plan",
      changes: [],
    },
    parentSession: supervisorSession(),
  });
  const duplicate = validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.plan",
      changes: [
        { id: "a", title: "A", rationale: "r" },
        { id: "a", title: "A again", rationale: "r" },
      ],
    },
    parentSession: supervisorSession(),
  });
  const unknownDep = validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.plan",
      changes: [
        { id: "a", title: "A", rationale: "r", dependsOn: ["ghost"] },
        { id: "b", title: "B", rationale: "r" },
      ],
    },
    parentSession: supervisorSession(),
  });
  const cyclic = validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.plan",
      changes: [
        { id: "a", title: "A", rationale: "r", dependsOn: ["b"] },
        { id: "b", title: "B", rationale: "r", dependsOn: ["a"] },
      ],
    },
    parentSession: supervisorSession(),
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.ok ? valid.kind : null, "change_plan");
  assert.deepEqual(
    valid.ok && valid.kind === "change_plan" ? valid.plan.changes[1]?.dependsOn : null,
    ["change-core"],
  );
  assert.equal(single.ok, true);
  assert.deepEqual(empty, {
    ok: false,
    safeReason: "Change plans must contain between 1 and 8 changes.",
  });
  assert.deepEqual(duplicate, { ok: false, safeReason: "Change ids must be unique within a plan." });
  assert.deepEqual(unknownDep, {
    ok: false,
    safeReason: "Change dependency references an unknown change id: ghost.",
  });
  assert.deepEqual(cyclic, { ok: false, safeReason: "Change dependencies must be acyclic." });
});

test("accepts changeId on task lists and delegation requests", () => {
  const list = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.task_list",
      changeId: " change-core ",
      tasks: [{ id: "task-1", title: "T", acceptance: [{ id: "A1", text: "Done." }] }],
    },
    parentSession: supervisorSession(),
  });
  const request = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.request",
      role: "worker",
      prompt: "Do task one.",
      taskId: "task-1",
      changeId: "change-core",
    },
    parentSession: supervisorSession(),
  });

  assert.equal(list.ok && list.kind === "task_list" ? list.changeId : null, "change-core");
  assert.equal(
    request.ok && request.kind === "delegation" ? request.request.changeId : null,
    "change-core",
  );
});

test("validates goal reassessment control events", () => {
  const unsatisfied = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: false,
      evidence: [" Change core-loop delivered and archived. "],
      remainingGaps: [{ refs: ["new:multiplayer-modes"], summary: " Multiplayer mode is still missing. " }],
      nextEpochRationale: " Integration surfaced the missing multiplayer surface. ",
    },
    parentSession: supervisorSession(),
  });
  const satisfied = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: true,
      evidence: ["All acceptance criteria pass against the original goal."],
    },
    parentSession: supervisorSession(),
  });

  assert.equal(unsatisfied.ok, true);
  assert.equal(unsatisfied.ok ? unsatisfied.kind : null, "reassessment");
  if (unsatisfied.ok && unsatisfied.kind === "reassessment") {
    assert.equal(unsatisfied.reassessment.goalSatisfied, false);
    assert.deepEqual(unsatisfied.reassessment.evidence, ["Change core-loop delivered and archived."]);
    assert.deepEqual(unsatisfied.reassessment.remainingGaps, [{ refs: ["new:multiplayer-modes"], summary: "Multiplayer mode is still missing." }]);
    assert.equal(
      unsatisfied.reassessment.nextEpochRationale,
      "Integration surfaced the missing multiplayer surface.",
    );
  }
  assert.equal(satisfied.ok, true);
  if (satisfied.ok && satisfied.kind === "reassessment") {
    assert.equal(satisfied.reassessment.goalSatisfied, true);
    assert.deepEqual(satisfied.reassessment.remainingGaps, []);
    assert.equal(satisfied.reassessment.nextEpochRationale, null);
  }
});

test("rejects malformed goal reassessment control events", () => {
  const missingEvidence = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: true,
      evidence: [],
    },
    parentSession: supervisorSession(),
  });
  const unsatisfiedWithoutGaps = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: false,
      evidence: ["e"],
      remainingGaps: [],
      nextEpochRationale: "r",
    },
    parentSession: supervisorSession(),
  });
  const unsatisfiedWithoutRationale = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: false,
      evidence: ["e"],
      remainingGaps: [{ refs: ["new:gap"], summary: "gap" }],
    },
    parentSession: supervisorSession(),
  });
  const satisfiedWithGaps = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: true,
      evidence: ["e"],
      remainingGaps: [{ refs: ["new:gap"], summary: "gap" }],
    },
    parentSession: supervisorSession(),
  });
  const nonBoolean = validateManagedControlEvent({
    controlEvent: {
      type: "managed_goal.reassessment",
      goalSatisfied: "yes",
      evidence: ["e"],
    },
    parentSession: supervisorSession(),
  });

  assert.deepEqual(missingEvidence, {
    ok: false,
    safeReason: "Reassessment requires at least one non-empty evidence string.",
  });
  assert.deepEqual(unsatisfiedWithoutGaps, {
    ok: false,
    safeReason: "An unsatisfied reassessment requires at least one structured remaining gap.",
  });
  assert.deepEqual(unsatisfiedWithoutRationale, {
    ok: false,
    safeReason: "An unsatisfied reassessment requires a non-empty nextEpochRationale.",
  });
  assert.deepEqual(satisfiedWithGaps, {
    ok: false,
    safeReason: "A satisfied reassessment must not list remaining gaps.",
  });
  assert.deepEqual(nonBoolean, {
    ok: false,
    safeReason: "Reassessment goalSatisfied must be a boolean.",
  });
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

test("validates strict managed review decisions against the frozen attempt contract", () => {
  const valid = validateManagedReviewDecision({
    controlEvent: {
      type: "managed_review.decision",
      workerDelegationRequestId: "worker-2",
      verdict: "accepted",
      decisions: [
        { criterionId: "A1", outcome: "PASS", safeSummary: "Tests pass." },
        { criterionId: "A2", outcome: "PASS", safeSummary: "Docs exist." },
      ],
      safeSummary: "All criteria pass.",
    },
    expectedWorkerDelegationRequestId: "worker-2",
    frozenCriteria: [{ id: "A1", text: "Tests" }, { id: "A2", text: "Docs" }],
  });
  assert.equal(valid.ok, true);

  const incomplete = validateManagedReviewDecision({
    controlEvent: {
      type: "managed_review.decision", workerDelegationRequestId: "worker-2", verdict: "accepted",
      decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }], safeSummary: "Incomplete",
    },
    expectedWorkerDelegationRequestId: "worker-2",
    frozenCriteria: [{ id: "A1", text: "Tests" }, { id: "A2", text: "Docs" }],
  });
  assert.deepEqual(incomplete, { ok: false, safeReason: "Judge decision must cover every frozen criterion exactly once." });

  const wrongAttempt = validateManagedReviewDecision({
    controlEvent: {
      type: "managed_review.decision", workerDelegationRequestId: "worker-1", verdict: "blocked",
      decisions: [
        { criterionId: "A1", outcome: "BLOCKED", safeSummary: "Unavailable" },
        { criterionId: "A2", outcome: "PASS", safeSummary: "Pass" },
      ], safeSummary: "Blocked",
    },
    expectedWorkerDelegationRequestId: "worker-2",
    frozenCriteria: [{ id: "A1", text: "Tests" }, { id: "A2", text: "Docs" }],
  });
  assert.deepEqual(wrongAttempt, { ok: false, safeReason: "Judge decision targets a different worker attempt." });
});

test("validates Integrator results against exact durable identities", () => {
  const expected = {
    expectedIntegrationAttemptId: "integration-1",
    expectedWorkerDelegationRequestId: "worker-1",
    expectedOriginalCandidateCommitSha: "abc123",
  };
  const valid = validateManagedIntegrationResult({
    controlEvent: {
      type: "managed_integration.result",
      integrationAttemptId: "integration-1",
      workerDelegationRequestId: "worker-1",
      originalCandidateCommitSha: "abc123",
      safeSummary: "Resolved both conflict markers.",
    },
    ...expected,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.ok ? valid.result.safeSummary : null, "Resolved both conflict markers.");

  assert.deepEqual(validateManagedIntegrationResult({ controlEvent: null, ...expected }), {
    ok: false,
    safeReason: "Not a managed_integration.result control event.",
  });
  assert.deepEqual(validateManagedIntegrationResult({
    controlEvent: {
      type: "managed_integration.result",
      integrationAttemptId: "integration-other",
      workerDelegationRequestId: "worker-1",
      originalCandidateCommitSha: "abc123",
      safeSummary: "Wrong target",
    },
    ...expected,
  }), { ok: false, safeReason: "Integrator result targets a different integration attempt." });
  assert.deepEqual(validateManagedIntegrationResult({
    controlEvent: {
      type: "managed_integration.result",
      integrationAttemptId: "integration-1",
      workerDelegationRequestId: "worker-other",
      originalCandidateCommitSha: "abc123",
      safeSummary: "Wrong worker",
    },
    ...expected,
  }), { ok: false, safeReason: "Integrator result targets a different worker attempt." });
  assert.deepEqual(validateManagedIntegrationResult({
    controlEvent: {
      type: "managed_integration.result",
      integrationAttemptId: "integration-1",
      workerDelegationRequestId: "worker-1",
      originalCandidateCommitSha: "foreign",
      safeSummary: "Wrong candidate",
    },
    ...expected,
  }), { ok: false, safeReason: "Integrator result targets a different original candidate." });
  assert.deepEqual(validateManagedIntegrationResult({
    controlEvent: {
      type: "managed_integration.result",
      integrationAttemptId: "integration-1",
      workerDelegationRequestId: "worker-1",
      originalCandidateCommitSha: "abc123",
      safeSummary: "   ",
    },
    ...expected,
  }), { ok: false, safeReason: "Integrator result requires a safe summary." });
});

test("requires exactly one Integrator result block", () => {
  const expected = {
    expectedIntegrationAttemptId: "integration-1",
    expectedWorkerDelegationRequestId: "worker-1",
    expectedOriginalCandidateCommitSha: "abc123",
  };
  const payload = {
    type: "managed_integration.result",
    integrationAttemptId: "integration-1",
    workerDelegationRequestId: "worker-1",
    originalCandidateCommitSha: "abc123",
    safeSummary: "Resolved.",
  };
  assert.deepEqual(selectManagedIntegrationResult({ controlEvents: [], ...expected }), {
    ok: false,
    safeReason: "Integrator completed without a managed_integration.result block.",
  });
  assert.deepEqual(selectManagedIntegrationResult({ controlEvents: [payload, payload], ...expected }), {
    ok: false,
    safeReason: "Integrator emitted more than one managed_integration.result block.",
  });
  assert.equal(selectManagedIntegrationResult({ controlEvents: [{ type: "progress" }, payload], ...expected }).ok, true);
});

test("binds integration re-review to the exact resolved candidate", () => {
  const base = {
    expectedWorkerDelegationRequestId: "worker-1",
    expectedIntegrationAttemptId: "integration-1",
    expectedReviewedCandidateCommitSha: "candidate-2",
    frozenCriteria: [{ id: "A1", text: "Pass" }],
  };
  const decision = {
    type: "managed_review.decision",
    workerDelegationRequestId: "worker-1",
    integrationAttemptId: "integration-1",
    reviewedCandidateCommitSha: "candidate-2",
    verdict: "accepted",
    decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
    safeSummary: "Accepted",
  };
  assert.equal(validateManagedReviewDecision({ controlEvent: decision, ...base }).ok, true);
  assert.deepEqual(validateManagedReviewDecision({
    controlEvent: { ...decision, reviewedCandidateCommitSha: "candidate-old" }, ...base,
  }), { ok: false, safeReason: "Judge decision targets a different reviewed candidate." });
  assert.deepEqual(validateManagedReviewDecision({
    controlEvent: { ...decision, integrationAttemptId: "integration-old" }, ...base,
  }), { ok: false, safeReason: "Judge decision targets a different integration attempt." });
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

test("validates a Supervisor spec review control event", () => {
  assert.deepEqual(validateManagedControlEvent({
    controlEvent: {
      type: "managed_change.spec_review",
      changeId: "change-one",
      workerDelegationRequestId: "worker-1",
      decision: "approve",
      summary: "The spec is semantically sufficient.",
    },
    parentSession: supervisorSession(),
  }), {
    ok: true,
    kind: "spec_review",
    review: {
      type: "managed_change.spec_review",
      changeId: "change-one",
      workerDelegationRequestId: "worker-1",
      decision: "approve",
      summary: "The spec is semantically sufficient.",
    },
  });
});

test("rejects malformed Supervisor spec reviews", () => {
  for (const controlEvent of [
    { type: "managed_change.spec_review", changeId: "", workerDelegationRequestId: "worker-1", decision: "approve", summary: "ok" },
    { type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: "", decision: "approve", summary: "ok" },
    { type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: "worker-1", decision: "maybe", summary: "ok" },
    { type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: "worker-1", decision: "reject", summary: "" },
  ]) {
    assert.equal(validateManagedControlEvent({ controlEvent, parentSession: supervisorSession() }).ok, false);
  }
});

test("accepts acceptance criteria carrying a valid executable check", () => {
  const result = validateManagedControlEvent({
    controlEvent: {
      type: "managed_delegation.task_list",
      tasks: [{
        id: "task-1",
        title: "Notes storage",
        acceptance: [{
          id: "A1",
          text: "Storage round-trips notes.",
          check: {
            kind: "red_green",
            command: "  node --test tests/notes.test.js  ",
            timeoutMs: 60000,
            protectedPaths: [" tests/notes.test.js "],
          },
        }],
      }],
    },
    parentSession: supervisorSession(),
  });
  assert.equal(result.ok, true);
  if (result.ok && result.kind === "task_list") {
    assert.deepEqual(result.tasks[0]!.acceptance![0]!.check, {
      kind: "red_green",
      command: "node --test tests/notes.test.js",
      timeoutMs: 60000,
      protectedPaths: ["tests/notes.test.js"],
    });
  }
});

test("rejects malformed executable checks with teaching reasons", () => {
  const base = (check: Record<string, unknown>) => ({
    type: "managed_delegation.task_list",
    tasks: [{
      id: "task-1", title: "T",
      acceptance: [{ id: "A1", text: "Cond.", check }],
    }],
  });
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ kind: "vibes", command: "npm test" }, /kind/i],
    [{ kind: "red_green", command: "  " }, /command/i],
    [{ kind: "red_green", command: "npm test", timeoutMs: -5 }, /timeout/i],
    [{ kind: "red_green", command: "npm test", protectedPaths: [""] }, /protected/i],
    [{ kind: "red_green", command: "npm test", protectedPaths: "tests" }, /protected/i],
  ];
  for (const [check, pattern] of cases) {
    const result = validateManagedControlEvent({ controlEvent: base(check), parentSession: supervisorSession() });
    assert.equal(result.ok, false, JSON.stringify(check));
    assert.match(result.ok ? "" : result.safeReason, pattern, JSON.stringify(check));
  }
});
