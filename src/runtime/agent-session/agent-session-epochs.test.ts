import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentSessionHandle,
} from "../../domain/index.js";
import { openDatabase } from "../../persistence/database.js";
import type { EventBus } from "../../persistence/event-bus.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { evaluateManagedCompletion } from "./managed-completion-evaluator.js";
import type { OpenSpecWorkspaceService } from "./openspec-workspace-service.js";

import {
  adapterWithEvents,
  changePlanEvent,
  createHandle,
  createManagerFixture,
  recordingOpenSpecService,
  runScript,
  scriptedEpochAdapter,
  specFlow,
  waitFor,
} from "./agent-session-test-harness.js";

test("continuation exhaustion preserves rejected completion gaps and reports unsuccessful completion", async () => {
  const fixture = createManagerFixture("rejected completion bound");
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  managedTaskRepo.registerTasks({
    goalId: fixture.goal.id,
    tasks: [{ id: "task-1", title: "Incomplete", acceptance: [{ id: "A1", text: "Must pass" }] }],
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      return createHandle(input.sessionId, [
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Request completion.", occurredAt: "2026-07-16T00:00:01.000Z",
          metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Claim complete." } },
        },
        {
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Turn ended.", occurredAt: "2026-07-16T00:00:02.000Z",
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture, database: fixture.db, managedTaskRepo, maxSupervisorContinuations: 1,
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejected = events.filter((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((event) => Array.isArray(event.data.completionGaps)));
  const blocked = events.find((event) => event.data.runtimeEventType === "supervisor.continuations_exhausted");
  assert.equal(blocked?.type, "goal.input_requested");
  assert.match(String(blocked?.data.reason), /without reaching successful completion/i);
  assert.equal(blocked?.data.completionRequestEvaluated, true);
  assert.deepEqual(blocked?.data.completionGaps, rejected.at(-1)?.data.completionGaps);
  assert.ok((blocked?.data.completionGaps as Array<{ type: string }>).some((gap) => gap.type === "criterion_not_passed"));
  const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id);
  assert.equal(pending?.reasonCode, "continuation_exhausted");
  fixture.db.close();
});

test("direct narrowing advances archive, next change, reassessment, and completion without a control loop", async () => {
  const fixture = createManagerFixture("direct narrowing staged pipeline");
  const openSpec = recordingOpenSpecService("cli");
  const gates = Array.from({ length: 10 }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  });
  let releaseIndex = 0;
  let reviewIndex = 0;
  let supervisorStarted = false;
  const allRequests = () => fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
    .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id));
  const latestWorkerId = () => allRequests().filter((request) => request.role === "worker" && request.resultSummary).at(-1)!.id;
  const control = (
    input: { sessionId: string; goalId: string; runId: string },
    block: Record<string, unknown>,
    occurredAt: string,
  ): AgentRuntimeEvent => ({
    type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
    message: "Staged pipeline control.", occurredAt, metadata: { delegationControlEvent: block },
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        if (input.prompt.includes("review") || input.prompt.includes("Judge")) {
          reviewIndex += 1;
          const rejected = reviewIndex === 2 || reviewIndex === 3;
          return createHandle(input.sessionId, [{
            type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: rejected ? "A1 still fails after independent review." : "Review merge accepted and merged.",
            occurredAt: `2026-07-17T00:01:${String(reviewIndex).padStart(2, "0")}.000Z`,
            metadata: {
              reviewMergeApplyOutcome: rejected
                ? { status: "rejected", safeSummary: "A1 still fails." }
                : { status: "merged", safeSummary: "Merged." },
            },
          }]);
        }
        return createHandle(input.sessionId, [{
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Worker completed its contracted task.", occurredAt: "2026-07-17T00:01:00.000Z",
        }]);
      }
      if (supervisorStarted) return createHandle(input.sessionId, []);
      supervisorStarted = true;
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield {
            ...changePlanEvent([
              { id: "change-one", title: "First", rationale: "Split lineage." },
              { id: "change-two", title: "Second", rationale: "Tail change." },
            ]),
            sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          } satisfies AgentRuntimeEvent;
          yield control(input, {
            type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
            prompt: "Author change-one specs.", summary: "Author change-one specs.",
          }, "2026-07-17T00:00:01.000Z");
          await gates[0]!.promise;
          yield control(input, {
            type: "managed_change.spec_review", changeId: "change-one",
            workerDelegationRequestId: latestWorkerId(), decision: "approve",
            summary: "change-one spec is semantically sufficient.",
          }, "2026-07-17T00:00:01.500Z");
          yield control(input, {
            type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: latestWorkerId(),
            prompt: "Judge and review merge change-one specs.", summary: "Review change-one specs.",
          }, "2026-07-17T00:00:02.000Z");
          await gates[1]!.promise;
          yield control(input, {
            type: "managed_delegation.task_list", tasks: [{
              id: "parent", title: "Large implementation",
              acceptance: [{ id: "A1", text: "First slice passes." }, { id: "A2", text: "Second slice passes." }],
            }],
          }, "2026-07-17T00:00:03.000Z");
          for (let attempt = 0; attempt < 2; attempt += 1) {
            yield control(input, {
              type: "managed_delegation.request", role: "worker", taskId: "parent",
              prompt: "Implement the large task.", summary: "Implement parent.",
            }, `2026-07-17T00:00:${4 + attempt * 2}.000Z`);
            await gates[2 + attempt * 2]!.promise;
            yield control(input, {
              type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: latestWorkerId(),
              prompt: "Judge review A1 and reject if it still fails.", summary: "Review parent.",
            }, `2026-07-17T00:00:${5 + attempt * 2}.000Z`);
            await gates[3 + attempt * 2]!.promise;
          }
          yield control(input, {
            type: "managed_delegation.task_list", tasks: [{
              id: "child", title: "First slice only", parentTaskId: "parent",
              acceptance: [{ id: "A1", text: "First slice passes." }],
            }],
          }, "2026-07-17T00:00:08.000Z");
          yield control(input, {
            type: "managed_delegation.request", role: "worker", taskId: "child",
            prompt: "Implement only A1.", summary: "Implement child.",
          }, "2026-07-17T00:00:09.000Z");
          await gates[6]!.promise;
          yield control(input, {
            type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: latestWorkerId(),
            prompt: "Judge and review merge child.", summary: "Review child.",
          }, "2026-07-17T00:00:10.000Z");
          await gates[7]!.promise;
          yield control(input, {
            type: "managed_delegation.request", role: "worker", taskId: "spec:change-two",
            prompt: "Author change-two specs.", summary: "Author change-two specs.",
          }, "2026-07-17T00:00:11.000Z");
          await gates[8]!.promise;
          yield control(input, {
            type: "managed_change.spec_review", changeId: "change-two",
            workerDelegationRequestId: latestWorkerId(), decision: "approve",
            summary: "change-two spec is semantically sufficient.",
          }, "2026-07-17T00:00:11.500Z");
          yield control(input, {
            type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: latestWorkerId(),
            prompt: "Judge and review merge change-two specs.", summary: "Review change-two specs.",
          }, "2026-07-17T00:00:12.000Z");
          await gates[9]!.promise;
          yield control(input, {
            type: "managed_goal.reassessment", goalSatisfied: true,
            evidence: ["Both changes archived through the repaired child lineage."],
          }, "2026-07-17T00:00:13.000Z");
          yield control(input, {
            type: "managed_delegation.complete", summary: "Staged pipeline completed without exhaustion.",
          }, "2026-07-17T00:00:14.000Z");
        },
        async send() {
          gates[releaseIndex++]?.release();
        },
      };
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
    worktreeAttestor: () => ["src/change.ts"],
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const types = events.map((event) => event.data.runtimeEventType);
  const splitIndex = types.indexOf("supervisor.task_list", types.indexOf("task.rejection_recorded") + 1);
  const archiveIndex = types.indexOf("change.archived");
  const nextActivationIndex = types.findIndex((type, index) =>
    type === "change.activated" && index > archiveIndex
  );
  assert.equal(events.filter((event) => event.data.runtimeEventType === "task.rejection_recorded").length, 2);
  assert.ok(splitIndex >= 0 && splitIndex < archiveIndex);
  assert.ok(archiveIndex < nextActivationIndex);
  assert.deepEqual(events.filter((event) => event.data.runtimeEventType === "change.archived")
    .map((event) => event.data.changeId), ["change-one", "change-two"]);
  assert.ok(types.includes("supervisor.reassessment"));
  assert.ok(types.includes("supervisor.completed"));
  assert.ok(!types.includes("supervisor.continuations_exhausted"));
  fixture.db.close();
});

test("does not scaffold a change plan when durable synthetic task registration fails", async () => {
  const fixture = createManagerFixture("durable registration failure");
  const openSpec = recordingOpenSpecService("cli");
  const persistedTasks = createManagedTaskRepository(fixture.db);
  const manager = createAgentSessionManager({
    ...fixture,
    managedTaskRepo: {
      ...persistedTasks,
      registerTasks() {
        throw new Error("injected durable registration failure");
      },
    },
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  // The fault is contained durably (event-pump containment) instead of
  // rejecting the caller; the plan must still not scaffold.
  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([changePlanEvent([
      { id: "feature-a", title: "Feature A", rationale: "First slice." },
      { id: "feature-b", title: "Feature B", rationale: "Second slice." },
    ])]),
  });

  assert.deepEqual(openSpec.scaffolded, []);
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "supervisor.change_plan"));
  const pumpFailure = events.find(
    (event) => event.data.runtimeEventType === "runtime.event_pump_failed",
  );
  assert.ok(pumpFailure, "expected the registration fault to surface as a durable pump failure");
  assert.match(String(pumpFailure.data.safeReason), /injected durable registration failure/);
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "failed");
  fixture.db.close();
});

test("rejects a change plan that violates the plan budget without registering changes", async () => {
  const fixture = createManagerFixture("empty change plan goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([changePlanEvent([])]);
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejection = events.find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(rejection, "expected the plan to be rejected");
  assert.match(String(rejection.data.safeReason), /between 1 and 8/i);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "supervisor.change_plan"));
  assert.ok(!events.some((event) => event.data.runtimeEventType === "change.activated"));
  assert.deepEqual(openSpec.scaffolded, []);

  fixture.db.close();
});

test("accepts a single-change plan as one planning epoch", async () => {
  const fixture = createManagerFixture("single change plan goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([
    changePlanEvent([{ id: "only-change", title: "Only change", rationale: "Small planned goal." }]),
  ]);
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const planEvent = events.find((event) => event.data.runtimeEventType === "supervisor.change_plan");
  assert.ok(planEvent, "expected the single-change plan to be accepted");
  assert.equal(planEvent.data.epochSequence, 1);
  assert.equal(planEvent.data.epochRationale, undefined);
  assert.deepEqual(openSpec.scaffolded.map((call) => call.changeId), ["only-change"]);

  fixture.db.close();
});

test("rejects a second change plan without an unsatisfied reassessment", async () => {
  const fixture = createManagerFixture("re-planned goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([
    changePlanEvent([
      { id: "change-one", title: "Change one", rationale: "First slice." },
      { id: "change-two", title: "Change two", rationale: "Second slice." },
    ]),
    changePlanEvent([
      { id: "change-three", title: "Change three", rationale: "Replanned slice." },
      { id: "change-four", title: "Change four", rationale: "Replanned slice." },
    ]),
  ]);
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const planEvents = events.filter((event) => event.data.runtimeEventType === "supervisor.change_plan");
  assert.equal(planEvents.length, 1);
  const rejection = events.find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(rejection, "expected the second plan to be rejected");
  assert.match(String(rejection.data.safeReason), /unsatisfied goal reassessment/i);
  assert.deepEqual(
    openSpec.scaffolded.map((call) => call.changeId),
    ["change-one", "change-two"],
  );

  fixture.db.close();
});

test("gates change archives on merged evidence and goal completion on all changes archived", async () => {
  const fixture = createManagerFixture("change lifecycle goal");
  const openSpec = recordingOpenSpecService("cli");
  const gates = Array.from({ length: 6 }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  let sendCount = 0;
  let supervisorStarted = false;
  let childCount = 0;
  const workerSuccess = (input: { sessionId: string; goalId: string; runId: string }): AgentRuntimeEvent => ({
    type: "session.completed",
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message: "Worker finished.",
    occurredAt: "2026-07-13T00:00:03.000Z",
  });
  const reviewMerged = (input: { sessionId: string; goalId: string; runId: string }): AgentRuntimeEvent => ({
    type: "session.completed",
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message: "Review merge completed.",
    occurredAt: "2026-07-13T00:00:04.000Z",
    metadata: {
      reviewMergeApplyOutcome: { status: "merged", diffSummary: "changes applied", safeSummary: "Merged." },
    },
  });
  const latestWorkerRequestId = (parentSessionId: string) =>
    fixture.agentSessionRepo
      .listDelegationRequests(parentSessionId)
      .filter((request) => request.role === "worker" && request.resultSummary)
      .at(-1)?.id ?? "missing";
  const controlEvent = (
    input: { sessionId: string; goalId: string; runId: string },
    controlBlock: Record<string, unknown>,
    at: string,
  ): AgentRuntimeEvent => ({
    type: "progress",
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message: "Supervisor control block.",
    occurredAt: at,
    metadata: { delegationControlEvent: controlBlock },
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childCount += 1;
        // Odd children are workers, even children are review merges.
        return createHandle(input.sessionId, [childCount % 2 === 1 ? workerSuccess(input) : reviewMerged(input)]);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield {
            ...changePlanEvent([
              { id: "change-one", title: "Change one", rationale: "First slice." },
              { id: "change-two", title: "Change two", rationale: "Second slice." },
            ]),
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
          } satisfies AgentRuntimeEvent;
          yield controlEvent(
            input,
            {
              type: "managed_delegation.request",
              role: "worker",
              taskId: "spec:change-one",
              prompt: "Author change-one specs.",
              summary: "Author change-one specs.",
            },
            "2026-07-13T00:00:02.000Z",
          );
          await gates[0]!.promise;
          yield controlEvent(
            input,
            {
              type: "managed_change.spec_review",
              changeId: "change-one",
              workerDelegationRequestId: latestWorkerRequestId(input.sessionId),
              decision: "approve",
              summary: "change-one spec is semantically sufficient.",
            },
            "2026-07-13T00:00:04.500Z",
          );
          yield controlEvent(
            input,
            {
              type: "managed_delegation.request",
              role: "review_merge",
              workerDelegationRequestId: latestWorkerRequestId(input.sessionId),
              prompt: "Merge change-one specs.",
              summary: "Merge change-one specs.",
            },
            "2026-07-13T00:00:05.000Z",
          );
          await gates[1]!.promise;
          yield controlEvent(
            input,
            {
              type: "managed_delegation.task_list",
              tasks: [
                {
                  id: "task-1",
                  title: "Implement change one",
                  acceptance: [{ id: "A1", text: "The slice works." }],
                },
              ],
            },
            "2026-07-13T00:00:06.000Z",
          );
          yield controlEvent(
            input,
            {
              type: "managed_delegation.request",
              role: "worker",
              taskId: "task-1",
              prompt: "Implement change one.",
              summary: "Implement change one.",
            },
            "2026-07-13T00:00:07.000Z",
          );
          await gates[2]!.promise;
          yield controlEvent(
            input,
            {
              type: "managed_delegation.request",
              role: "review_merge",
              workerDelegationRequestId: latestWorkerRequestId(input.sessionId),
              prompt: "Merge change one implementation.",
              summary: "Merge change one implementation.",
            },
            "2026-07-13T00:00:08.000Z",
          );
          await gates[3]!.promise;
          // Premature completion: change-two is still unarchived.
          yield controlEvent(
            input,
            { type: "managed_delegation.complete", summary: "All done." },
            "2026-07-13T00:00:09.000Z",
          );
          yield controlEvent(
            input,
            {
              type: "managed_delegation.request",
              role: "worker",
              taskId: "spec:change-two",
              prompt: "Author change-two specs.",
              summary: "Author change-two specs.",
            },
            "2026-07-13T00:00:10.000Z",
          );
          await gates[4]!.promise;
          yield controlEvent(
            input,
            {
              type: "managed_change.spec_review",
              changeId: "change-two",
              workerDelegationRequestId: latestWorkerRequestId(input.sessionId),
              decision: "approve",
              summary: "change-two spec is semantically sufficient.",
            },
            "2026-07-13T00:00:10.500Z",
          );
          yield controlEvent(
            input,
            {
              type: "managed_delegation.request",
              role: "review_merge",
              workerDelegationRequestId: latestWorkerRequestId(input.sessionId),
              prompt: "Merge change-two specs.",
              summary: "Merge change-two specs.",
            },
            "2026-07-13T00:00:11.000Z",
          );
          await gates[5]!.promise;
          // Completion before a reassessment: rejected (AC5).
          yield controlEvent(
            input,
            { type: "managed_delegation.complete", summary: "Both changes delivered." },
            "2026-07-13T00:00:12.000Z",
          );
          yield controlEvent(
            input,
            {
              type: "managed_goal.reassessment",
              goalSatisfied: true,
              evidence: ["Both changes archived with merged evidence."],
            },
            "2026-07-13T00:00:13.000Z",
          );
          yield controlEvent(
            input,
            { type: "managed_delegation.complete", summary: "Both changes delivered." },
            "2026-07-13T00:00:14.000Z",
          );
        },
        async send() {
          gates[sendCount++]?.release();
        },
      };
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
    worktreeAttestor: () => ["src/change.ts"],
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const eventOfType = (type: string) => events.filter((event) => event.data.runtimeEventType === type);

  // task-1 finished with attested changes but no merge yet: archive is blocked durably.
  const blocked = eventOfType("change.archive_blocked");
  assert.ok(blocked.length >= 1, "expected a durable archive-blocked event");
  assert.equal(blocked[0]!.data.changeId, "change-one");
  assert.equal(blocked[0]!.data.blockerType, "unmerged_changes");
  assert.match(String(blocked[0]!.data.safeReason), /review-merged/i);

  // Archives happen in order and activate the next change.
  assert.deepEqual(
    eventOfType("change.archived").map((event) => event.data.changeId),
    ["change-one", "change-two"],
  );
  assert.deepEqual(
    eventOfType("change.activated").map((event) => event.data.changeId),
    ["change-one", "change-two"],
  );
  assert.deepEqual(
    openSpec.archived.map((call) => [call.changeId, call.cwd]),
    [
      ["change-one", "C:\\goal-workspace"],
      ["change-two", "C:\\goal-workspace"],
    ],
  );
  for (const call of openSpec.archived) {
    assert.match(call.date, /^\d{4}-\d{2}-\d{2}$/);
  }

  // The premature completion was rejected naming the remaining change.
  const completionRejection = eventOfType("delegation.rejected").find((event) =>
    String(event.data.safeReason).includes("change-two"),
  );
  assert.ok(completionRejection, "expected the early completion to be rejected");
  assert.match(String(completionRejection.data.safeReason), /unarchived/i);

  // The final completion was accepted.
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "completed");
  assert.ok(events.some((event) => event.type === "goal.completed"));

  // Spec-writer delegations were contracted with the frozen S1-S3 criteria.
  const specAccepted = eventOfType("delegation.accepted").filter((event) =>
    String(event.data.taskId ?? "").startsWith("spec:"),
  );
  assert.deepEqual(
    specAccepted.map((event) => event.data.taskId),
    ["spec:change-one", "spec:change-two"],
  );

  // The whole change lifecycle is reconstructable from durable events alone.
  const changeLifecycleTypes = new Set([
    "supervisor.change_plan",
    "change.activated",
    "change.spec_review_requested",
    "change.spec_supervisor_approved",
    "change.spec_merged",
    "change.archive_blocked",
    "change.archived",
    "delegation.rejected",
    "supervisor.reassessment",
    "supervisor.completed",
  ]);
  const lifecycle = events
    .filter((event) => changeLifecycleTypes.has(String(event.data.runtimeEventType)))
    .map((event) => [event.data.runtimeEventType, event.data.changeId ?? null]);
  assert.deepEqual(lifecycle, [
    ["supervisor.change_plan", null],
    ["change.activated", "change-one"],
    ["change.spec_review_requested", "change-one"],
    ["change.spec_supervisor_approved", "change-one"],
    ["change.spec_merged", "change-one"],
    ["change.archive_blocked", "change-one"],
    ["change.archived", "change-one"],
    ["change.activated", "change-two"],
    ["delegation.rejected", null],
    ["change.spec_review_requested", "change-two"],
    ["change.spec_supervisor_approved", "change-two"],
    ["change.spec_merged", "change-two"],
    ["change.archived", "change-two"],
    ["delegation.rejected", null],
    ["supervisor.reassessment", null],
    ["supervisor.completed", null],
    ["supervisor.completed", null],
  ]);

  // The completion-without-reassessment rejection names the missing gate.
  const reassessmentRejection = eventOfType("delegation.rejected").find((event) =>
    /managed_goal\.reassessment/.test(String(event.data.safeReason)),
  );
  assert.ok(reassessmentRejection, "expected completion to require a reassessment first");
  const reassessmentEvent = eventOfType("supervisor.reassessment")[0];
  assert.ok(reassessmentEvent, "expected a durable reassessment event");
  assert.equal(reassessmentEvent.data.goalSatisfied, true);
  assert.equal(reassessmentEvent.data.epochSequence, 1);

  fixture.db.close();
});

test("writes a durable archive intent before workspace mutation and finalizes one archive event", async () => {
  const fixture = createManagerFixture("durable archive intent");
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  let archiveMutationCount = 0;
  let supervisorTurn = 0;
  const archiveIdentity = {
    sourcePath: "C:\\goal-workspace\\openspec\\changes\\change-one",
    targetPath: "C:\\goal-workspace\\openspec\\changes\\archive\\2026-07-17-change-one",
    manifestDigest: "a".repeat(64),
    preArchiveHead: "head-before",
  };
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive: () => ({ ok: true, ...archiveIdentity }),
    archiveChange() {
      const intent = fixture.db.prepare(`
        SELECT status FROM managed_change_archive_operations
        WHERE goal_id = ? AND change_id = 'change-one'
      `).get(fixture.goal.id) as { status: string } | undefined;
      assert.equal(intent?.status, "pending", "intent must commit before workspace mutation");
      archiveMutationCount += 1;
      return { ok: true, archiveCommitSha: "head-after", ...archiveIdentity };
    },
  };
  const allRequests = () => fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
    .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id));
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        if (input.prompt.includes("Independent Judge contract")) {
          const workerId = allRequests().find((request) => request.role === "worker")!.id;
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Accepted.", occurredAt: "2026-07-17T00:00:04.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerId, verdict: "accepted",
                decisions: ["S1", "S2", "S3"].map((criterionId) => ({
                  criterionId, outcome: "PASS", safeSummary: "Pass",
                })),
                safeSummary: "Spec accepted.", deferredFindings: [],
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge complete.", occurredAt: "2026-07-17T00:00:05.000Z" },
          ]);
        }
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec evidence.", occurredAt: "2026-07-17T00:00:02.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "spec:change-one",
              criterionEvidence: ["S1", "S2", "S3"].map((criterionId) => ({ criterionId, evidence: "Verified" })),
              claimedFiles: [], tests: [],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Worker complete.", occurredAt: "2026-07-17T00:00:03.000Z" },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          { ...changePlanEvent([{ id: "change-one", title: "One", rationale: "Archive safely." }]),
            sessionId: input.sessionId, goalId: input.goalId, runId: input.runId },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Write spec.", occurredAt: "2026-07-17T00:00:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
              prompt: "Author specs.", summary: "Author specs.",
            } },
          },
        ]);
      }
      const workerId = allRequests().find((request) => request.role === "worker")!.id;
      if (supervisorTurn === 2) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Approve spec.", occurredAt: "2026-07-17T00:00:03.400Z",
            metadata: { delegationControlEvent: {
              type: "managed_change.spec_review", changeId: "change-one",
              workerDelegationRequestId: workerId, decision: "approve",
              summary: "change-one spec is semantically sufficient.",
            } },
          },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Review spec.", occurredAt: "2026-07-17T00:00:03.500Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: workerId,
              prompt: "Judge spec.", summary: "Judge spec.",
            } },
          },
        ]);
      }
      return createHandle(input.sessionId, [
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Reassess.", occurredAt: "2026-07-17T00:00:06.000Z",
          metadata: { delegationControlEvent: {
            type: "managed_goal.reassessment", goalSatisfied: true, evidence: ["Spec archived."],
          } },
        },
        {
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Complete.", occurredAt: "2026-07-17T00:00:07.000Z",
          metadata: { delegationControlEvent: {
            type: "managed_delegation.complete", summary: "Archive intent flow complete.",
          } },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture, database: fixture.db, managedTaskRepo, openSpecWorkspaceService: openSpec,
    supervisorCwd: "C:\\goal-workspace",
    worktreeAttestor: () => ["openspec/changes/change-one/proposal.md"],
    managedDeliveryService: {
      prepareCandidate() {
        return { ok: true as const, candidateCommitSha: "candidate", checkpointHead: "base",
          candidateFiles: ["openspec/changes/change-one/proposal.md"] };
      },
      deliverCandidate() {
        return { status: "committed" as const, safeSummary: "Spec delivery committed.", checkpointHead: "base",
          checkpointStatus: "clean" as const, candidateCommitSha: "candidate", commitSha: "delivered",
          validationCommand: "npm test", validationExitCode: 0, validationSummary: "passed", rollbackSummary: null };
      },
    },
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  assert.equal(archiveMutationCount, 1);
  assert.equal(fixture.db.prepare(`
    SELECT status FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = 'change-one'
  `).pluck().get(fixture.goal.id), "committed");
  assert.equal(fixture.eventRepo.listForGoal(fixture.goal.id)
    .filter((event) => event.data.runtimeEventType === "change.archived").length, 1);
  fixture.db.close();
});

test("turns an archive service exception into a durable sanitized failed outcome", async () => {
  const fixture = createManagerFixture("durable archive exception");
  fixture.goalRepo.updateStatus(fixture.goal.id, "interrupted", {
    completedAt: "2026-07-17T00:00:00.000Z",
  });
  const tasks = createManagedTaskRepository(fixture.db);
  tasks.registerTasks({
    goalId: fixture.goal.id,
    changeId: "change-one",
    tasks: [{ id: "spec:change-one", title: "Done", acceptance: [{ id: "A1", text: "Done" }] }],
  });
  fixture.db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(fixture.goal.id);
  fixture.db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
  fixture.eventRepo.create({
    goalId: fixture.goal.id,
    type: "agent.progress",
    message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [{ id: "change-one", title: "One", rationale: "Archive" }],
    },
  });
  fixture.eventRepo.create({
    goalId: fixture.goal.id,
    type: "agent.progress",
    message: "Spec approved",
    data: { runtimeEventType: "change.spec_approved", changeId: "change-one" },
  });
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive: () => ({
      ok: true,
      sourcePath: "C:\\goal-workspace\\openspec\\changes\\change-one",
      targetPath: "C:\\goal-workspace\\openspec\\changes\\archive\\2026-07-17-change-one",
      manifestDigest: "a".repeat(64),
      preArchiveHead: "head-before",
    }),
    archiveChange: () => {
      throw new Error("permission denied at C:\\goal-workspace\\openspec\\changes");
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo: tasks,
    openSpecWorkspaceService: openSpec,
    supervisorCwd: "C:\\goal-workspace",
    maxSupervisorContinuations: 0,
  });

  await manager.resumeInterruptedGoal({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([{
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Complete",
      occurredAt: "2026-07-17T00:00:01.000Z",
      metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Done" } },
    }]),
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.runtimeEventType === "change.archive_failed"));

  const failed = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "change.archive_failed")!;
  assert.equal(failed.data.blockerType, "archive_operation_failed");
  assert.match(String(failed.data.safeReason), /^permission denied at <goal-workspace>/);
  assert.equal(fixture.db.prepare(`
    SELECT status FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = 'change-one'
  `).pluck().get(fixture.goal.id), "blocked");
  fixture.db.close();
});

test("durable archive mode blocks when the workspace service lacks prepareArchive", async () => {
  const fixture = createManagerFixture("durable archive capability missing");
  fixture.goalRepo.updateStatus(fixture.goal.id, "interrupted", {
    completedAt: "2026-07-17T00:00:00.000Z",
  });
  const tasks = createManagedTaskRepository(fixture.db);
  tasks.registerTasks({
    goalId: fixture.goal.id,
    changeId: "change-one",
    tasks: [{ id: "spec:change-one", title: "Done", acceptance: [{ id: "A1", text: "Done" }] }],
  });
  fixture.db.prepare("UPDATE managed_tasks SET status = 'accepted' WHERE goal_id = ?").run(fixture.goal.id);
  fixture.db.prepare("UPDATE managed_task_criteria SET outcome = 'PASS'").run();
  fixture.eventRepo.create({
    goalId: fixture.goal.id,
    type: "agent.progress",
    message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [{ id: "change-one", title: "One", rationale: "Archive" }],
    },
  });
  fixture.eventRepo.create({
    goalId: fixture.goal.id,
    type: "agent.progress",
    message: "Spec approved",
    data: { runtimeEventType: "change.spec_approved", changeId: "change-one" },
  });
  let legacyArchiveCalls = 0;
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    archiveChange: () => {
      legacyArchiveCalls += 1;
      return { ok: true };
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo: tasks,
    openSpecWorkspaceService: openSpec,
    supervisorCwd: "C:\\goal-workspace",
    maxSupervisorContinuations: 0,
  });

  await manager.resumeInterruptedGoal({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([{
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Complete",
      occurredAt: "2026-07-17T00:00:01.000Z",
      metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Done" } },
    }]),
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id).some((event) =>
    ["change.archive_blocked", "change.archive_failed", "change.archived"].includes(
      String(event.data.runtimeEventType),
    ),
  ));

  assert.equal(legacyArchiveCalls, 0);
  const blocker = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "change.archive_blocked");
  assert.equal(blocker?.data.blockerType, "archive_capability_unavailable");
  assert.equal(fixture.db.prepare(`
    SELECT COUNT(*) FROM managed_change_archive_operations WHERE goal_id = ? AND change_id = 'change-one'
  `).pluck().get(fixture.goal.id), 0);
  assert.equal(fixture.eventRepo.listForGoal(fixture.goal.id)
    .filter((event) => event.data.runtimeEventType === "change.archived").length, 0);
  fixture.db.close();
});

test("durable archive blockers expose undelivered and invalid-lineage task ids", async (t) => {
  for (const scenario of [
    "undelivered",
    "invalid-lineage",
    "frozen-tamper",
    "frozen-contract-ambiguity",
    "frozen-contract-truncated-legacy",
    "frozen-contract-malformed-json",
    "frozen-contract-non-object",
  ] as const) {
    await t.test(scenario, async () => {
    const fixture = createManagerFixture(`archive blocker ${scenario}`);
    fixture.goalRepo.updateStatus(fixture.goal.id, "interrupted", {
      completedAt: "2026-07-17T00:00:00.000Z",
    });
    const tasks = createManagedTaskRepository(fixture.db);
    tasks.registerTasks({
      goalId: fixture.goal.id,
      changeId: "change-one",
      tasks: [{ id: "spec:change-one", title: "Spec", acceptance: [{ id: "S1", text: "Valid" }] }],
    });
    fixture.db.prepare(`
      UPDATE managed_task_criteria SET outcome = 'PASS'
      WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'spec:change-one')
    `).run(fixture.goal.id);
    fixture.db.prepare(`
      UPDATE managed_tasks SET status = 'accepted'
      WHERE goal_id = ? AND logical_task_id = 'spec:change-one'
    `).run(fixture.goal.id);
    if (scenario === "undelivered") {
      tasks.registerTasks({
        goalId: fixture.goal.id,
        changeId: "change-one",
        tasks: [{ id: "implementation", title: "Pending", acceptance: [{ id: "A1", text: "Deliver" }] }],
      });
    } else if ([
      "frozen-contract-ambiguity",
      "frozen-contract-truncated-legacy",
      "frozen-contract-malformed-json",
      "frozen-contract-non-object",
    ].includes(scenario)) {
      tasks.registerTasks({
        goalId: fixture.goal.id,
        changeId: "change-one",
        tasks: [{ id: "implementation", title: "Guessed contract", acceptance: [{ id: "A1", text: "Guessed pass" }] }],
      });
      fixture.db.prepare(`UPDATE managed_tasks SET status = 'accepted'
        WHERE goal_id = ? AND logical_task_id = 'implementation'`).run(fixture.goal.id);
      fixture.db.prepare(`UPDATE managed_task_criteria SET outcome = 'PASS'
        WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'implementation')`)
        .run(fixture.goal.id);
      const marker = {
          mode: "initialized_repair",
          ambiguousTaskCount: 51,
          ambiguousTasks: Array.from({ length: 50 }, (_, index) =>
            `other-goal-${String(index + 1).padStart(3, "0")}:implementation`
          ),
          ...(scenario === "frozen-contract-ambiguity" ? { ambiguousTaskEnforcementIds: [
            ...Array.from({ length: 50 }, (_, index) =>
              `other-goal-${String(index + 1).padStart(3, "0")}:implementation`
            ),
            `${fixture.goal.id}:implementation`,
          ] } : {}),
        };
      const markerDetails = scenario === "frozen-contract-malformed-json"
        ? "{not-json"
        : scenario === "frozen-contract-non-object"
          ? "[]"
          : JSON.stringify(marker);
      fixture.db.prepare(`UPDATE schema_migrations SET details = ?
        WHERE name = 'managed-task-frozen-contract-repair-v1'`).run(markerDetails);
    } else {
      tasks.registerTasks({
        goalId: fixture.goal.id,
        changeId: "change-one",
        tasks: [{
          id: "parent", title: "Parent",
          acceptance: [{ id: "A1", text: "First" }, { id: "A2", text: "Second" }],
        }],
      });
      fixture.db.prepare(`
        UPDATE managed_tasks SET status = 'rejected', attempt_count = 2, substantive_rejection_count = 2,
          last_cited_criteria = '["A1"]'
        WHERE goal_id = ? AND logical_task_id = 'parent'
      `).run(fixture.goal.id);
      tasks.registerTasks({
        goalId: fixture.goal.id,
        changeId: "change-one",
        tasks: [{
          id: "child", title: "Child", parentTaskId: "parent",
          acceptance: [{ id: "A1", text: "First" }],
        }],
      });
      if (scenario === "invalid-lineage") {
        // Incident-shaped corruption: a child exists but its parent is no longer durably split.
        fixture.db.prepare(`
          UPDATE managed_tasks SET status = 'accepted'
          WHERE goal_id = ? AND logical_task_id = 'parent'
        `).run(fixture.goal.id);
      } else {
        fixture.db.prepare(`UPDATE managed_tasks SET status = 'accepted'
          WHERE goal_id = ? AND logical_task_id = 'child'`).run(fixture.goal.id);
        fixture.db.prepare(`UPDATE managed_task_criteria SET outcome = 'PASS'
          WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'child')`)
          .run(fixture.goal.id);
        const parentDatabaseId = fixture.db.prepare(`SELECT id FROM managed_tasks
          WHERE goal_id = ? AND logical_task_id = 'parent'`).pluck().get(fixture.goal.id) as string;
        fixture.db.prepare(`
          INSERT INTO managed_tasks (
            id, goal_id, logical_task_id, change_id, parent_task_id, title, status, attempt_count,
            substantive_rejection_count, last_cited_criteria, last_safe_summary, created_at, updated_at
          ) VALUES ('archive-tampered-child-db', ?, 'tampered-child', 'change-one', ?, 'Tampered',
            'accepted', 0, 0, '[]', NULL, '2026-07-17T00:00:02.000Z', '2026-07-17T00:00:02.000Z')
        `).run(fixture.goal.id, parentDatabaseId);
        fixture.db.prepare(`
          INSERT INTO managed_task_criteria (task_id, criterion_id, text, outcome, created_at, updated_at)
          VALUES ('archive-tampered-child-db', 'T1', 'Tampered', 'PASS',
            '2026-07-17T00:00:02.000Z', '2026-07-17T00:00:02.000Z')
        `).run();
        assert.ok(evaluateManagedCompletion(fixture.db, { goalId: fixture.goal.id }).gaps.some((gap) =>
          gap.type === "invalid_split_lineage" && gap.reasonCode === "frozen_child_set_mismatch"
        ));
      }
    }
    fixture.eventRepo.create({
      goalId: fixture.goal.id,
      type: "agent.progress",
      message: "Plan",
      data: {
        runtimeEventType: "supervisor.change_plan",
        changePlan: [{ id: "change-one", title: "One", rationale: "Test blocker" }],
      },
    });
    fixture.eventRepo.create({
      goalId: fixture.goal.id,
      type: "agent.progress",
      message: "Spec approved",
      data: { runtimeEventType: "change.spec_approved", changeId: "change-one" },
    });
    let archiveCalls = 0;
    const openSpec: OpenSpecWorkspaceService = {
      mode: () => "cli",
      scaffoldChange: () => ({ ok: true, committed: true }),
      validateChange: () => ({ ok: true, failures: [] }),
      prepareArchive(input) {
        return {
          ok: true,
          sourcePath: `C:\\goal-workspace\\openspec\\changes\\${input.changeId}`,
          targetPath: `C:\\goal-workspace\\openspec\\changes\\archive\\2026-07-17-${input.changeId}`,
          manifestDigest: "a".repeat(64),
          preArchiveHead: "head-before",
        };
      },
      archiveChange() {
        archiveCalls += 1;
        return { ok: false, safeReason: "Archive should not run while a durable task gate is blocked." };
      },
    };
    const manager = createAgentSessionManager({
      ...fixture,
      database: fixture.db,
      managedTaskRepo: tasks,
      openSpecWorkspaceService: openSpec,
      supervisorCwd: "C:\\goal-workspace",
      maxSupervisorContinuations: 0,
    });

    await manager.resumeInterruptedGoal({
      goalId: fixture.goal.id,
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      adapter: adapterWithEvents([{
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Complete",
        occurredAt: "2026-07-17T00:00:01.000Z",
        metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Done" } },
      }]),
    });
    await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
      .some((event) => ["change.archive_blocked", "change.archive_failed"].includes(
        String(event.data.runtimeEventType),
      )));

    const blocked = fixture.eventRepo.listForGoal(fixture.goal.id)
      .find((event) => event.data.runtimeEventType === "change.archive_blocked");
    assert.ok(blocked, `expected ${scenario} to block before archive execution`);
    assert.equal(blocked.data.blockerType,
      scenario === "undelivered" ? "undelivered_task" : "invalid_split_lineage");
    assert.deepEqual(blocked.data.taskIds,
      scenario === "undelivered" ? ["implementation"]
          : scenario === "invalid-lineage" ? ["child", "parent"]
          : scenario === "frozen-tamper" ? ["child", "parent", "tampered-child"]
            : scenario === "frozen-contract-ambiguity" ? ["implementation"] : undefined);
    if (scenario !== "undelivered") {
      assert.equal(blocked.data.reasonCode,
        scenario === "invalid-lineage" ? "parent_not_split"
          : scenario === "frozen-tamper" ? "frozen_child_set_mismatch"
            : "ambiguous_frozen_contract");
    }
    assert.equal(archiveCalls, 0);
    fixture.db.close();
    });
  }
});

test("durable split lineage, not continuation policy, archives and activates the next change", async () => {
  const fixture = createManagerFixture("durable split continuation compatibility");
  fixture.goalRepo.updateStatus(fixture.goal.id, "interrupted", { completedAt: "2026-07-17T00:00:00.000Z" });
  const tasks = createManagedTaskRepository(fixture.db);
  tasks.registerTasks({
    goalId: fixture.goal.id,
    changeId: "change-one",
    tasks: [
      { id: "spec:change-one", title: "Spec one", acceptance: [{ id: "S1", text: "Valid" }] },
      { id: "parent", title: "Parent", acceptance: [{ id: "A1", text: "One" }, { id: "A2", text: "Two" }] },
    ],
  });
  fixture.db.prepare(`UPDATE managed_tasks SET status = 'accepted'
    WHERE goal_id = ? AND logical_task_id = 'spec:change-one'`).run(fixture.goal.id);
  fixture.db.prepare(`UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'spec:change-one')`)
    .run(fixture.goal.id);
  fixture.db.prepare(`UPDATE managed_tasks SET status = 'rejected', attempt_count = 2,
    substantive_rejection_count = 2, last_cited_criteria = '["A1"]'
    WHERE goal_id = ? AND logical_task_id = 'parent'`).run(fixture.goal.id);
  tasks.registerTasks({
    goalId: fixture.goal.id,
    changeId: "change-one",
    tasks: [{ id: "child", title: "Child", parentTaskId: "parent", acceptance: [{ id: "A1", text: "One" }] }],
  });
  fixture.db.prepare(`UPDATE managed_tasks SET status = 'accepted'
    WHERE goal_id = ? AND logical_task_id = 'child'`).run(fixture.goal.id);
  fixture.db.prepare(`UPDATE managed_task_criteria SET outcome = 'PASS'
    WHERE task_id = (SELECT id FROM managed_tasks WHERE goal_id = ? AND logical_task_id = 'child')`)
    .run(fixture.goal.id);
  assert.deepEqual(evaluateManagedCompletion(fixture.db, { goalId: fixture.goal.id }), { ok: true, gaps: [] });
  tasks.registerTasks({
    goalId: fixture.goal.id,
    changeId: "change-two",
    tasks: [{ id: "spec:change-two", title: "Spec two", acceptance: [{ id: "S1", text: "Valid" }] }],
  });
  fixture.eventRepo.create({
    goalId: fixture.goal.id,
    type: "agent.progress",
    message: "Plan",
    data: {
      runtimeEventType: "supervisor.change_plan",
      changePlan: [
        { id: "change-one", title: "One", rationale: "Split" },
        { id: "change-two", title: "Two", rationale: "Next", dependsOn: ["change-one"] },
      ],
    },
  });
  fixture.eventRepo.create({
    goalId: fixture.goal.id,
    type: "agent.progress",
    message: "Spec one approved",
    data: { runtimeEventType: "change.spec_approved", changeId: "change-one" },
  });
  let turn = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      turn += 1;
      if (turn === 1) {
        return createHandle(input.sessionId, [{
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Try completion", occurredAt: "2026-07-17T00:00:01.000Z",
          metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Advance" } },
        }]);
      }
      return {
        ...createHandle(input.sessionId, []),
        async *events() { await new Promise<void>(() => undefined); },
      };
    },
  };
  const archiveIdentity = {
    sourcePath: "C:\\goal-workspace\\openspec\\changes\\change-one",
    targetPath: "C:\\goal-workspace\\openspec\\changes\\archive\\2026-07-17-change-one",
    manifestDigest: "a".repeat(64),
    preArchiveHead: "head-before",
  };
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive: () => ({ ok: true, ...archiveIdentity }),
    archiveChange: () => ({ ok: true, archiveCommitSha: "head-after", ...archiveIdentity }),
  };
  const manager = createAgentSessionManager({
    ...fixture, database: fixture.db, managedTaskRepo: tasks,
    openSpecWorkspaceService: openSpec, supervisorCwd: "C:\\goal-workspace",
  });

  await manager.resumeInterruptedGoal({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.runtimeEventType === "change.activated" && event.data.changeId === "change-two"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const split = events.findIndex((event) => event.data.runtimeEventType === "managed_task.lineage_split");
  const archived = events.findIndex((event) => event.data.runtimeEventType === "change.archived"
    && event.data.changeId === "change-one");
  const activated = events.findIndex((event) => event.data.runtimeEventType === "change.activated"
    && event.data.changeId === "change-two");
  assert.ok(split >= 0 && split < archived && archived < activated);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "supervisor.continuations_exhausted"));
  fixture.db.close();
});

test("ambiguous archive topology is durably blocked with a sanitized reason", async () => {
  const fixture = createManagerFixture("ambiguous archive topology");
  const tasks = createManagedTaskRepository(fixture.db);
  let supervisorTurn = 0;
  const openSpec: OpenSpecWorkspaceService = {
    mode: () => "cli",
    scaffoldChange: () => ({ ok: true, committed: true }),
    validateChange: () => ({ ok: true, failures: [] }),
    prepareArchive: () => ({
      ok: false,
      safeReason: "C:\\goal-workspace\\openspec\\changes and target are both present",
    }),
    archiveChange: () => ({ ok: false, safeReason: "must not mutate" }),
  };
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        const workerId = fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
          .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id))
          .find((request) => request.role === "worker")!.id;
        if (input.prompt.includes("Independent Judge")) {
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Accepted", occurredAt: "2026-07-17T00:00:04.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerId, verdict: "accepted",
                decisions: ["S1", "S2", "S3"].map((criterionId) => ({
                  criterionId, outcome: "PASS", safeSummary: "Pass",
                })),
                safeSummary: "Accepted", deferredFindings: [],
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge complete", occurredAt: "2026-07-17T00:00:04.500Z" },
          ]);
        }
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Evidence", occurredAt: "2026-07-17T00:00:02.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "spec:change-one",
              criterionEvidence: ["S1", "S2", "S3"].map((criterionId) => ({ criterionId, evidence: "Verified" })),
              claimedFiles: [], tests: [],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Worker complete", occurredAt: "2026-07-17T00:00:02.500Z" },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          { ...changePlanEvent([{ id: "change-one", title: "One", rationale: "Archive" }]),
            sessionId: input.sessionId, goalId: input.goalId, runId: input.runId },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Write spec", occurredAt: "2026-07-17T00:00:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
              prompt: "Author specs", summary: "Author specs",
            } },
          },
        ]);
      }
      const workerId = fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
        .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id))
        .find((request) => request.role === "worker")!.id;
      if (supervisorTurn === 2) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Approve", occurredAt: "2026-07-17T00:00:02.900Z",
            metadata: { delegationControlEvent: {
              type: "managed_change.spec_review", changeId: "change-one",
              workerDelegationRequestId: workerId, decision: "approve",
              summary: "change-one spec is semantically sufficient.",
            } },
          },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Review", occurredAt: "2026-07-17T00:00:03.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: workerId,
              prompt: "Judge spec", summary: "Judge spec",
            } },
          },
        ]);
      }
      return createHandle(input.sessionId, [{
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Complete", occurredAt: "2026-07-17T00:00:05.000Z",
        metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Done" } },
      }]);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture, database: fixture.db, managedTaskRepo: tasks,
    openSpecWorkspaceService: openSpec, supervisorCwd: "C:\\goal-workspace", maxSupervisorContinuations: 0,
    worktreeAttestor: () => ["openspec/changes/change-one/proposal.md"],
    managedDeliveryService: {
      prepareCandidate() {
        return { ok: true as const, candidateCommitSha: "candidate", checkpointHead: "base",
          candidateFiles: ["openspec/changes/change-one/proposal.md"] };
      },
      deliverCandidate() {
        return { status: "committed" as const, safeSummary: "Spec delivery committed.", checkpointHead: "base",
          checkpointStatus: "clean" as const, candidateCommitSha: "candidate", commitSha: "delivered",
          validationCommand: "npm test", validationExitCode: 0, validationSummary: "passed", rollbackSummary: null };
      },
    },
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.blockerType === "archive_state_ambiguous"));

  const blocked = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((event) => event.data.blockerType === "archive_state_ambiguous")!;
  assert.equal(blocked.data.runtimeEventType, "change.archive_blocked");
  assert.match(String(blocked.data.safeReason), /^<goal-workspace>\/openspec\/changes/);
  assert.ok(!String(blocked.data.safeReason).includes("C:\\goal-workspace"));
  fixture.db.close();
});

test("admits a next epoch after an unsatisfied reassessment and completes after a satisfied one", async () => {
  const fixture = createManagerFixture("multi epoch goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 4, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "First batch." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one delivered and archived."],
            remainingGaps: [{ refs: ["new:e2e-verification"], summary: "End-to-end verification is missing." }],
            nextEpochRationale: "Integration revealed a verification gap.",
          },
          "2026-07-13T00:00:04.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-two", title: "Verification", rationale: "Close the verification gap." }],
          },
          "2026-07-13T00:00:05.000Z",
        );
        yield* specFlow(tools, "change-two", 2, (offset) => `2026-07-13T00:00:0${6 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: true,
            evidence: ["Verification change archived; original goal is met."],
          },
          "2026-07-13T00:00:08.000Z",
        );
        yield tools.controlEvent(
          { type: "managed_delegation.complete", summary: "Goal delivered over two epochs." },
          "2026-07-13T00:00:09.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const eventOfType = (type: string) => events.filter((event) => event.data.runtimeEventType === type);

  const planEvents = eventOfType("supervisor.change_plan");
  assert.deepEqual(planEvents.map((event) => event.data.epochSequence), [1, 2]);
  assert.equal(planEvents[0]!.data.epochRationale, undefined);
  assert.equal(planEvents[1]!.data.epochRationale, "Integration revealed a verification gap.");
  assert.deepEqual(
    (planEvents[1]!.data.changePlan as Array<{ id: string }>).map((change) => change.id),
    ["change-two"],
  );

  const reassessments = eventOfType("supervisor.reassessment");
  assert.deepEqual(
    reassessments.map((event) => [event.data.goalSatisfied, event.data.epochSequence]),
    [
      [false, 1],
      [true, 2],
    ],
  );
  assert.deepEqual(reassessments[0]!.data.remainingGaps, [{ refs: ["new:e2e-verification"], summary: "End-to-end verification is missing." }]);

  assert.deepEqual(
    eventOfType("change.archived").map((event) => event.data.changeId),
    ["change-one", "change-two"],
  );
  assert.deepEqual(
    eventOfType("change.activated").map((event) => event.data.changeId),
    ["change-one", "change-two"],
  );
  assert.deepEqual(
    openSpec.scaffolded.map((call) => call.changeId),
    ["change-one", "change-two"],
  );
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "completed");

  fixture.db.close();
});

test("blocks the goal when consecutive reassessments repeat the same gaps", async () => {
  const fixture = createManagerFixture("repeated gaps goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 4, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "First batch." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: [{ refs: ["new:same-gap"], summary: "The same gap remains." }],
            nextEpochRationale: "Retry the gap.",
          },
          "2026-07-13T00:00:04.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-two", title: "Retry", rationale: "Close the gap again." }],
          },
          "2026-07-13T00:00:05.000Z",
        );
        yield* specFlow(tools, "change-two", 2, (offset) => `2026-07-13T00:00:0${6 + offset}.000Z`);
        // Identical gap signature modulo case and whitespace: circuit breaker.
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-two archived."],
            remainingGaps: [{ refs: ["new:same-gap"], summary: "The same gap is still unresolved." }],
            nextEpochRationale: "Try once more.",
          },
          "2026-07-13T00:00:08.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const breaker = events.find(
    (event) => event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker",
  );
  assert.ok(breaker, "expected a durable circuit-breaker event");
  assert.equal(breaker.type, "goal.input_requested");
  assert.match(String(breaker.data.safeReason), /same remaining gaps/i);
  assert.deepEqual(breaker.data.remainingGaps, [{ refs: ["new:same-gap"], summary: "The same gap is still unresolved." }]);
  // The breaker never offers a budget extension: repeating without new
  // information is exactly what it caught.
  assert.deepEqual(breaker.data.allowedDecisions, ["provide_guidance", "abandon"]);
  assert.equal(fixture.goalInputRequestRepo.getPending(fixture.goal.id)?.reasonCode, "reassessment_circuit_breaker");
  // Only the two consumed plans exist; no third epoch was admitted.
  assert.equal(
    events.filter((event) => event.data.runtimeEventType === "supervisor.change_plan").length,
    2,
  );

  fixture.db.close();
});

test("blocks the goal when the planning-epoch budget is exhausted with gaps remaining", async () => {
  const fixture = createManagerFixture("epoch budget goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 2, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "Only batch." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: [{ refs: ["new:more-work"], summary: "More work is needed." }],
            nextEpochRationale: "Open another epoch.",
          },
          "2026-07-13T00:00:04.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
    maxPlanningEpochs: 1,
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const exhausted = events.find(
    (event) => event.data.runtimeEventType === "supervisor.epoch_budget_exhausted",
  );
  assert.ok(exhausted, "expected a durable epoch-budget event");
  assert.equal(exhausted.type, "goal.input_requested");
  assert.match(String(exhausted.data.safeReason), /planning-epoch budget \(1\)/);
  assert.deepEqual(exhausted.data.allowedDecisions, ["extend_budget", "provide_guidance", "abandon"]);
  const pending = fixture.goalInputRequestRepo.getPending(fixture.goal.id);
  assert.equal(pending?.reasonCode, "epoch_budget_exhausted");
  assert.deepEqual(pending?.payload.remainingGaps, [{ refs: ["new:more-work"], summary: "More work is needed." }]);

  fixture.db.close();
});

test("rejects reassessments for flat goals and while changes remain unarchived", async () => {
  const flatFixture = createManagerFixture("flat goal reassessment");
  const flatManager = createAgentSessionManager({
    ...flatFixture,
    supervisorCwd: "C:\\goal-workspace",
  });
  await flatManager.startManagedSession({
    goalId: flatFixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: flatFixture.goal.id,
        runId: "run-placeholder",
        message: "Reassessing.",
        occurredAt: "2026-07-13T00:00:01.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_goal.reassessment",
            goalSatisfied: true,
            evidence: ["Flat flow finished."],
          },
        },
      },
    ]),
  });
  const flatRejection = flatFixture.eventRepo
    .listForGoal(flatFixture.goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(flatRejection, "expected the flat-goal reassessment to be rejected");
  assert.match(String(flatRejection.data.safeReason), /no change plan/i);
  flatFixture.db.close();

  const plannedFixture = createManagerFixture("premature reassessment");
  const openSpec = recordingOpenSpecService("cli");
  const plannedManager = createAgentSessionManager({
    ...plannedFixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });
  await plannedManager.startManagedSession({
    goalId: plannedFixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([
      changePlanEvent([{ id: "change-one", title: "Change one", rationale: "Batch." }]),
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: plannedFixture.goal.id,
        runId: "run-placeholder",
        message: "Reassessing too early.",
        occurredAt: "2026-07-13T00:00:02.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["Nothing archived yet."],
            remainingGaps: [{ refs: ["new:everything"], summary: "Everything." }],
            nextEpochRationale: "Way too early.",
          },
        },
      },
    ]),
  });
  const prematureRejection = plannedFixture.eventRepo
    .listForGoal(plannedFixture.goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(prematureRejection, "expected the premature reassessment to be rejected");
  assert.match(String(prematureRejection.data.safeReason), /archived or blocked first.*change-one/i);
  assert.equal(plannedFixture.goalRepo.getById(plannedFixture.goal.id)?.status, "running");
  plannedFixture.db.close();
});

test("REPRO-H6: reworded gaps with identical refs still trip the circuit breaker", async () => {
  const fixture = createManagerFixture("repro reworded gaps goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 4, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "First batch." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: [
              { refs: ["new:e2e-verification"], summary: "End-to-end verification is missing." },
            ],
            nextEpochRationale: "Close the verification gap.",
          },
          "2026-07-13T00:00:04.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-two", title: "Retry", rationale: "Close the gap again." }],
          },
          "2026-07-13T00:00:05.000Z",
        );
        yield* specFlow(tools, "change-two", 2, (offset) => `2026-07-13T00:00:0${6 + offset}.000Z`);
        // Same refs, reworded prose: identity is the ref-set, so the breaker
        // must fire regardless of the LLM's paraphrasing.
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-two archived."],
            remainingGaps: [
              { refs: ["new:e2e-verification"], summary: "There is still no end-to-end verification coverage." },
            ],
            nextEpochRationale: "Try once more.",
          },
          "2026-07-13T00:00:08.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => {
    const events = fixture.eventRepo.listForGoal(fixture.goal.id);
    return (
      events.some((event) => event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker") ||
      events.filter((event) => event.data.runtimeEventType === "supervisor.reassessment").length === 2
    );
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const breaker = events.find(
    (event) => event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker",
  );
  assert.ok(breaker, "identical ref-sets must trip the breaker even when the prose is reworded");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "waiting_user");
  fixture.db.close();
});

test("distinct gap refs admit the next epoch; unknown refs are rejected with the valid kinds", async () => {
  const fixture = createManagerFixture("distinct refs goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 4, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "First batch." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
        // Unknown ref: rejected with a teaching reason, state unchanged.
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: [{ refs: ["totally-unknown-artifact"], summary: "Something is missing." }],
            nextEpochRationale: "Close the gap.",
          },
          "2026-07-13T00:00:04.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: [{ refs: ["new:first-gap"], summary: "First distinct gap." }],
            nextEpochRationale: "Close the first gap.",
          },
          "2026-07-13T00:00:05.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-two", title: "Second", rationale: "Close the first gap." }],
          },
          "2026-07-13T00:00:06.000Z",
        );
        yield* specFlow(tools, "change-two", 2, (offset) => `2026-07-13T00:00:0${7 + offset}.000Z`);
        // Different ref-set: no breaker, third epoch admissible.
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-two archived."],
            remainingGaps: [{ refs: ["new:second-gap"], summary: "A different gap emerged." }],
            nextEpochRationale: "Close the second gap.",
          },
          "2026-07-13T00:00:09.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-three", title: "Third", rationale: "Close the second gap." }],
          },
          "2026-07-13T00:00:10.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .filter((event) => event.data.runtimeEventType === "supervisor.change_plan").length === 3);

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const unknownRef = events.find((event) =>
    event.data.runtimeEventType === "delegation.rejected" &&
    /totally-unknown-artifact/.test(String(event.data.safeReason)));
  assert.ok(unknownRef, "unknown ref must be rejected naming the ref");
  assert.match(String(unknownRef.data.safeReason), /change id.*task id.*capability.*new:/is);
  assert.ok(!events.some((event) =>
    event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker"));
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "running");
  fixture.db.close();
});
