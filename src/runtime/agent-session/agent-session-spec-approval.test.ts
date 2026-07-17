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
  createSpecReviewWorktree,
  recordingOpenSpecService,
  runScript,
  scriptedEpochAdapter,
  specReviewControlEvent,
  specWorkerDelegationEvent,
  waitFor,
} from "./agent-session-test-harness.js";

test("accepts a change plan, scaffolds in dependency order, activates the first change, and freezes spec task criteria", async () => {
  const fixture = createManagerFixture("change plan goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([
    changePlanEvent([
      { id: "feature-b", title: "Feature B", rationale: "Second slice.", dependsOn: ["feature-a"] },
      { id: "feature-a", title: "Feature A", rationale: "First slice." },
    ]),
    {
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Delegating spec authoring.",
      occurredAt: "2026-07-13T00:00:02.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.request",
          role: "worker",
          taskId: "spec:feature-a",
          prompt: "Author the OpenSpec artifacts for feature-a.",
          summary: "Author feature-a specs.",
        },
      },
    },
  ]);
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const planEvent = events.find((event) => event.data.runtimeEventType === "supervisor.change_plan");
  assert.ok(planEvent, "expected a durable change plan event");
  assert.deepEqual(
    (planEvent.data.changePlan as Array<{ id: string }>).map((change) => change.id),
    ["feature-b", "feature-a"],
  );
  assert.deepEqual(
    (planEvent.data.specTasks as Array<{ taskId: string; changeId: string }>).map((task) => [
      task.taskId,
      task.changeId,
    ]),
    [
      ["spec:feature-a", "feature-a"],
      ["spec:feature-b", "feature-b"],
    ],
  );
  assert.deepEqual(openSpec.scaffolded, [
    { changeId: "feature-a", cwd: "C:\\goal-workspace" },
    { changeId: "feature-b", cwd: "C:\\goal-workspace" },
  ]);
  const activated = events.filter((event) => event.data.runtimeEventType === "change.activated");
  assert.deepEqual(activated.map((event) => event.data.changeId), ["feature-a"]);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "runtime.openspec_unavailable"));

  const specRequest = fixture.agentSessionRepo
    .listDelegationRequests(result.session.id)
    .find((request) => request.taskId === "spec:feature-a");
  assert.ok(specRequest, "expected the spec task delegation to dispatch");
  assert.deepEqual(specRequest.acceptance?.map((criterion) => criterion.id), ["S1", "S2", "S3"]);

  fixture.db.close();
});

test("records OpenSpec materialization failures after preserving durable plan tasks", async () => {
  const fixture = createManagerFixture("materialization failure");
  const openSpec = recordingOpenSpecService("cli", {
    scaffoldResults: [
      { ok: false, committed: false, safeReason: "injected scaffold failure" },
      { ok: true, committed: true },
    ],
  });
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([changePlanEvent([
      { id: "feature-a", title: "Feature A", rationale: "First slice." },
      { id: "feature-b", title: "Feature B", rationale: "Second slice." },
    ])]),
  });

  assert.deepEqual(managedTaskRepo.listForGoal(fixture.goal.id).map((task) => task.id), [
    "spec:feature-a",
    "spec:feature-b",
  ]);
  const failure = fixture.eventRepo.listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "runtime.openspec_materialization_failed");
  assert.ok(failure);
  assert.match(JSON.stringify(failure.data.openspecScaffolds), /injected scaffold failure/);
  fixture.db.close();
});

test("rejects implementation delegations while the active change is still specifying", async () => {
  const fixture = createManagerFixture("premature implementation goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([
    changePlanEvent([
      { id: "change-one", title: "Change one", rationale: "First slice." },
      { id: "change-two", title: "Change two", rationale: "Second slice." },
    ]),
    {
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Announcing implementation tasks before the spec is merged.",
      occurredAt: "2026-07-13T00:00:02.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.task_list",
          tasks: [{ id: "task-1", title: "Implement it", acceptance: [{ id: "A1", text: "Works." }] }],
        },
      },
    },
    {
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Delegating implementation before the spec is merged.",
      occurredAt: "2026-07-13T00:00:03.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.request",
          role: "worker",
          taskId: "task-1",
          prompt: "Implement it.",
          summary: "Implement it.",
        },
      },
    },
  ]);
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejection = events.find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(rejection, "expected the premature implementation delegation to be rejected");
  assert.match(String(rejection.data.safeReason), /specifying/i);
  assert.match(String(rejection.data.safeReason), /spec:change-one/);
  assert.equal(fixture.agentSessionRepo.listDelegationRequests(result.session.id).length, 0);

  fixture.db.close();
});

test("keeps spec tasks owned by their own change when a task list spans changes", async () => {
  const fixture = createManagerFixture("cross-change task list goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([
    changePlanEvent([
      { id: "change-one", title: "Change one", rationale: "First slice." },
      { id: "change-two", title: "Change two", rationale: "Second slice.", dependsOn: ["change-one"] },
    ]),
    {
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Announcing tasks across both changes.",
      occurredAt: "2026-07-13T00:00:02.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.task_list",
          tasks: [
            { id: "task-1", title: "Implement change one", acceptance: [{ id: "A1", text: "Works." }] },
            { id: "spec:change-two", title: "Author change two specs" },
          ],
        },
      },
    },
    {
      // The later change's spec task must stay owned by change-two: delegating
      // it while change-one is active is out-of-order work.
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Delegating the later spec task early.",
      occurredAt: "2026-07-13T00:00:03.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.request",
          role: "worker",
          taskId: "spec:change-two",
          prompt: "Author the change-two specs.",
          summary: "Author the change-two specs.",
        },
      },
    },
  ]);
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejection = events.find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(rejection, "expected the early cross-change spec delegation to be rejected");
  assert.match(String(rejection.data.safeReason), /change-two is not active/i);
  assert.equal(fixture.agentSessionRepo.listDelegationRequests(result.session.id).length, 0);

  fixture.db.close();
});

test("appends the spec-writer appendix to spec task delegations without CLI workflow instructions", async () => {
  const fixture = createManagerFixture("spec writer prompt goal");
  const openSpec = recordingOpenSpecService("cli");
  const childPrompts: string[] = [];
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childPrompts.push(input.prompt);
        return createHandle(input.sessionId, []);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(input.sessionId, [
        {
          ...changePlanEvent([
            { id: "change-one", title: "Change one", rationale: "First slice of the goal." },
            { id: "change-two", title: "Change two", rationale: "Second slice.", dependsOn: ["change-one"] },
          ]),
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
        },
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Delegating spec authoring.",
          occurredAt: "2026-07-13T00:00:02.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.request",
              role: "worker",
              taskId: "spec:change-one",
              prompt: "Author the OpenSpec artifacts for change-one.",
              summary: "Author change-one specs.",
            },
          },
        },
      ]);
    },
  };
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

  assert.equal(childPrompts.length, 1);
  const prompt = childPrompts[0]!;
  // Change context and target paths.
  assert.match(prompt, /change-one/);
  assert.match(prompt, /Change one/);
  assert.match(prompt, /First slice of the goal\./);
  assert.match(prompt, /openspec\/changes\/change-one\/proposal\.md/);
  assert.match(prompt, /openspec\/changes\/change-one\/specs\//);
  assert.match(prompt, /openspec\/changes\/change-one\/tasks\.md/);
  // Artifact templates with a filled example, including the delta header the
  // strict validator requires.
  assert.match(prompt, /## ADDED Requirements/);
  assert.match(prompt, /### Requirement:/);
  assert.match(prompt, /#### Scenario:/);
  assert.match(prompt, /\*\*WHEN\*\*/);
  assert.match(prompt, /\*\*THEN\*\*/);
  assert.match(prompt, /Acceptance:/);
  // Frozen criteria ride the standard worker contract appendix.
  assert.match(prompt, /S1/);
  assert.match(prompt, /S2/);
  assert.match(prompt, /S3/);
  // No CLI workflow instructions leak into the agent prompt.
  assert.doesNotMatch(prompt, /openspec (propose|apply|archive|sync|list|validate|init)\b/i);
  assert.doesNotMatch(prompt, /opsx/i);

  fixture.db.close();
});

test("rejects spec-writer results whose worktree artifacts fail validation citing the failing criteria", async () => {
  const fixture = createManagerFixture("spec validation failure goal");
  const openSpec = recordingOpenSpecService("cli", {
    validateFailures: [
      [
        'requirement "Change plan control" needs at least one WHEN/THEN scenario',
        'task "- [ ] 1.1 Add types" is missing an acceptance line',
      ],
    ],
  });
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Spec artifacts authored.",
            occurredAt: "2026-07-13T00:00:03.000Z",
          },
        ]);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(input.sessionId, [
        {
          ...changePlanEvent([
            { id: "change-one", title: "Change one", rationale: "First slice." },
            { id: "change-two", title: "Change two", rationale: "Second slice." },
          ]),
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
        },
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Delegating spec authoring.",
          occurredAt: "2026-07-13T00:00:02.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.request",
              role: "worker",
              taskId: "spec:change-one",
              prompt: "Author the OpenSpec artifacts for change-one.",
              summary: "Author change-one specs.",
            },
          },
        },
      ]);
    },
  };
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
  await waitFor(() =>
    fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .some((event) => event.data.runtimeEventType === "task.rejection_recorded"),
  );

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejection = events.find((event) => event.data.runtimeEventType === "task.rejection_recorded");
  assert.ok(rejection, "expected a substantive rejection from spec validation");
  assert.equal(rejection.data.taskId, "spec:change-one");
  assert.deepEqual(rejection.data.citedCriteria, ["S2", "S3"]);
  assert.equal(openSpec.validated.length, 1);
  assert.equal(openSpec.validated[0]!.changeId, "change-one");
  assert.match(openSpec.validated[0]!.cwd, /^C:\\worktrees\\/);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "change.spec_approved"));

  fixture.db.close();
});

test("blocks only the change when spec authoring exhausts its retry budget", async () => {
  const fixture = createManagerFixture("spec budget goal");
  const openSpec = recordingOpenSpecService("cli", {
    validateFailures: [["tasks.md contains no tasks"], ["tasks.md contains no tasks"]],
  });
  let supervisorStarted = false;
  const gates = Array.from({ length: 2 }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  let sendCount = 0;
  const specDelegation = (
    input: { sessionId: string; goalId: string; runId: string },
    at: string,
  ): AgentRuntimeEvent => ({
    type: "progress",
    sessionId: input.sessionId,
    goalId: input.goalId,
    runId: input.runId,
    message: "Delegating spec authoring.",
    occurredAt: at,
    metadata: {
      delegationControlEvent: {
        type: "managed_delegation.request",
        role: "worker",
        taskId: "spec:change-one",
        prompt: "Author the OpenSpec artifacts.",
        summary: "Author change-one specs.",
      },
    },
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Spec artifacts authored.",
            occurredAt: "2026-07-13T00:00:03.000Z",
          },
        ]);
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
          yield specDelegation(input, "2026-07-13T00:00:02.000Z");
          await gates[0]!.promise;
          yield specDelegation(input, "2026-07-13T00:00:05.000Z");
          await gates[1]!.promise;
          yield specDelegation(input, "2026-07-13T00:00:08.000Z");
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
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.runtimeEventType === "change.blocked"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const blocked = events.find((event) => event.data.runtimeEventType === "change.blocked");
  assert.ok(blocked, "expected a durable change.blocked event");
  assert.equal(blocked.data.changeId, "change-one");
  assert.ok(!events.some((event) => event.type === "goal.blocked"), "the goal must survive the blocked change");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "running");
  const rejection = events.filter((event) => event.data.runtimeEventType === "delegation.rejected").at(-1);
  assert.match(String(rejection?.data.safeReason), /reassessment/i);

  fixture.db.close();
});

test("approves the spec change only after a merged review validates the goal workspace", async () => {
  const fixture = createManagerFixture("spec approval goal");
  const openSpec = recordingOpenSpecService("cli");
  let supervisorSessionId = "";
  let childCount = 0;
  let releaseParent!: () => void;
  const parentReleased = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childCount += 1;
        if (childCount === 1) {
          return createHandle(input.sessionId, [
            {
              type: "session.completed",
              sessionId: input.sessionId,
              goalId: input.goalId,
              runId: input.runId,
              message: "Spec artifacts authored.",
              occurredAt: "2026-07-13T00:00:03.000Z",
            },
          ]);
        }
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Review merge completed.",
            occurredAt: "2026-07-13T00:00:05.000Z",
            metadata: {
              reviewMergeApplyOutcome: {
                status: "merged",
                diffSummary: "3 files changed.",
                safeSummary: "Spec artifacts merged.",
              },
            },
          },
        ]);
      }
      if (supervisorSessionId) {
        return createHandle(input.sessionId, []);
      }
      supervisorSessionId = input.sessionId;
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
          yield {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Delegating spec authoring.",
            occurredAt: "2026-07-13T00:00:02.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "spec:change-one",
                prompt: "Author the OpenSpec artifacts for change-one.",
                summary: "Author change-one specs.",
              },
            },
          } satisfies AgentRuntimeEvent;
          await parentReleased;
          const workerRequest = fixture.agentSessionRepo
            .listDelegationRequests(input.sessionId)
            .find((request) => request.role === "worker" && request.resultSummary);
          yield {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Approving the validated spec attempt.",
            occurredAt: "2026-07-13T00:00:03.500Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_change.spec_review",
                changeId: "change-one",
                workerDelegationRequestId: workerRequest?.id ?? "missing",
                decision: "approve",
                summary: "change-one spec is semantically sufficient.",
              },
            },
          } satisfies AgentRuntimeEvent;
          yield {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Requesting spec review merge.",
            occurredAt: "2026-07-13T00:00:04.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "review_merge",
                workerDelegationRequestId: workerRequest?.id ?? "missing",
                prompt: "Review and merge the spec artifacts.",
                summary: "Review spec artifacts.",
              },
            },
          } satisfies AgentRuntimeEvent;
        },
        async send() {
          releaseParent();
        },
      };
    },
  };
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
  await waitFor(() =>
    fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .some((event) => event.data.runtimeEventType === "change.spec_merged"),
  );

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const approved = events.find((event) => event.data.runtimeEventType === "change.spec_merged");
  assert.ok(approved);
  assert.equal(approved.data.changeId, "change-one");
  // Pre-merge validation ran in the worker worktree; post-merge in the goal workspace.
  assert.equal(openSpec.validated.length, 2);
  assert.match(openSpec.validated[0]!.cwd, /^C:\\worktrees\\/);
  assert.equal(openSpec.validated[1]!.cwd, "C:\\goal-workspace");
  assert.deepEqual(
    openSpec.validated.map((call) => call.changeId),
    ["change-one", "change-one"],
  );
  // The merged transition only lands after the merged review outcome.
  const mergedIndex = events.findIndex((event) => event.data.runtimeEventType === "review_merge.apply_outcome");
  const approvedIndex = events.findIndex((event) => event.data.runtimeEventType === "change.spec_merged");
  assert.ok(mergedIndex >= 0 && approvedIndex > mergedIndex);

  fixture.db.close();
});

test("records a durable OpenSpec downgrade once when the CLI is unavailable", async () => {
  const fixture = createManagerFixture("degraded openspec goal");
  const openSpec = recordingOpenSpecService("degraded");
  const adapter = adapterWithEvents([
    changePlanEvent([
      { id: "change-one", title: "Change one", rationale: "First slice." },
      { id: "change-two", title: "Change two", rationale: "Second slice." },
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
  const downgrades = events.filter(
    (event) => event.data.runtimeEventType === "runtime.openspec_unavailable",
  );
  assert.equal(downgrades.length, 1);
  assert.ok(events.some((event) => event.data.runtimeEventType === "supervisor.change_plan"));
  assert.deepEqual(
    openSpec.scaffolded.map((call) => call.changeId),
    ["change-one", "change-two"],
  );

  fixture.db.close();
});

test("REPRO-H4: a validated spec result requires a Supervisor review gate before review-merge", async () => {
  const fixture = createManagerFixture("repro semantic spec review gate");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 2, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "Only slice." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        // Deliberately no managed_change.spec_review: the review-merge request
        // below must be rejected by the approval gate.
        yield tools.controlEvent(
          {
            type: "managed_delegation.request",
            role: "worker",
            taskId: "spec:change-one",
            prompt: "Author change-one specs.",
            summary: "Author change-one specs.",
          },
          "2026-07-13T00:00:02.000Z",
        );
        yield tools.gates[0]!.promise;
        yield tools.controlEvent(
          {
            type: "managed_delegation.request",
            role: "review_merge",
            workerDelegationRequestId: tools.latestWorkerRequestId(),
            prompt: "Merge change-one specs.",
            summary: "Merge change-one specs.",
          },
          "2026-07-13T00:00:03.000Z",
        );
        // A rejected control block does not resume the session; the script
        // ends here and the rejection is observed durably.
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
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id).some((event) =>
    event.data.runtimeEventType === "change.spec_approved" ||
    (event.data.runtimeEventType === "delegation.rejected" &&
      /approv/i.test(String(event.data.safeReason)))));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(
    events.some((event) => event.data.runtimeEventType === "change.spec_review_requested"),
    "backend must request a Supervisor semantic review after a structurally valid spec result",
  );
  assert.ok(
    events.some((event) =>
      event.data.runtimeEventType === "delegation.rejected" &&
      /approv/i.test(String(event.data.safeReason))),
    "review-merge without a Supervisor spec approval must be rejected",
  );
  fixture.db.close();
});

test("records a Supervisor spec rejection and gives the exact feedback to the corrective worker", async () => {
  const fixture = createManagerFixture("stateful spec rejection");
  const worktreePath = createSpecReviewWorktree("change-one");
  const openSpec = recordingOpenSpecService("cli");
  const childPrompts: string[] = [];
  const supervisorFeedback = "Add an explicit rollback scenario before approval.";
  let supervisorStarted = false;
  let continuationCount = 0;
  let releaseFirst!: () => void;
  const firstContinuation = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childPrompts.push(input.prompt);
        return createHandle(input.sessionId, [{
          type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Spec artifacts authored.", occurredAt: "2026-07-16T00:00:03.000Z",
        }]);
      }
      if (supervisorStarted) return createHandle(input.sessionId, []);
      supervisorStarted = true;
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield { ...changePlanEvent([
            { id: "change-one", title: "Change one", rationale: "First slice." },
            { id: "change-two", title: "Change two", rationale: "Second slice." },
          ]), sessionId: input.sessionId, goalId: input.goalId, runId: input.runId } satisfies AgentRuntimeEvent;
          yield specWorkerDelegationEvent(input, "2026-07-16T00:00:02.000Z");
          await firstContinuation;
          const workerId = fixture.agentSessionRepo.listDelegationRequests(input.sessionId)
            .find((request) => request.taskId === "spec:change-one")!.id;
          yield specReviewControlEvent(input, {
            type: "managed_change.spec_review", changeId: "change-one",
            workerDelegationRequestId: workerId, decision: "reject", summary: supervisorFeedback,
          }, "2026-07-16T00:00:04.000Z");
          yield specWorkerDelegationEvent(input, "2026-07-16T00:00:05.000Z");
        },
        async send() {
          continuationCount += 1;
          if (continuationCount === 1) releaseFirst();
        },
      };
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
    worktreeService: {
      async createChildWorktree() { return { path: worktreePath, label: "spec-review" }; },
      async removeWorktree() {},
    },
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => childPrompts.length === 2);

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejected = events.find((event) => event.data.runtimeEventType === "change.spec_supervisor_rejected");
  assert.ok(rejected, "expected a durable Supervisor rejection event");
  assert.equal(rejected.data.summary, supervisorFeedback);
  assert.match(childPrompts[1]!, /## Supervisor revision request/);
  assert.ok(childPrompts[1]!.includes(supervisorFeedback), "corrective prompt must carry the exact rejected summary");
  assert.ok(events.some((event) => event.data.runtimeEventType === "change.spec_review_requested"));
  fixture.db.close();
});

test("rejects a zero-attestation spec review without advancing the change", async () => {
  const fixture = createManagerFixture("durable zero-attestation spec");
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  const openSpec = recordingOpenSpecService("cli");
  const worktreePath = createSpecReviewWorktree("change-one");
  let supervisorTurn = 0;
  let specWorkerStarts = 0;
  let judgeStarts = 0;
  let statusBeforeCorrective: string | null = null;
  const allDelegations = () => fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
    .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id));
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        if (input.prompt.includes("Independent Judge contract")) {
          judgeStarts += 1;
          const workerId = allDelegations().find((request) => request.taskId === "spec:change-one")!.id;
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Spec judged.", occurredAt: "2026-07-17T01:00:04.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerId, verdict: "accepted",
                decisions: [
                  { criterionId: "S1", outcome: "PASS", safeSummary: "OpenSpec validation passed." },
                  { criterionId: "S2", outcome: "PASS", safeSummary: "Scenarios are complete." },
                  { criterionId: "S3", outcome: "PASS", safeSummary: "Tasks have acceptance criteria." },
                ],
                safeSummary: "Spec content is acceptable.", deferredFindings: [],
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge completed.", occurredAt: "2026-07-17T01:00:05.000Z" },
          ]);
        }
        specWorkerStarts += 1;
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec evidence.", occurredAt: "2026-07-17T01:00:02.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "spec:change-one",
              criterionEvidence: [
                { criterionId: "S1", evidence: "OpenSpec validation passed." },
                { criterionId: "S2", evidence: "Each requirement has a scenario." },
                { criterionId: "S3", evidence: "Each task has acceptance criteria." },
              ],
              tests: [], claimedFiles: [],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec worker completed without file changes.", occurredAt: "2026-07-17T01:00:03.000Z" },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          { ...changePlanEvent([
            { id: "change-one", title: "Change one", rationale: "First slice." },
            { id: "change-two", title: "Change two", rationale: "Second slice." },
          ]), sessionId: input.sessionId, goalId: input.goalId, runId: input.runId } satisfies AgentRuntimeEvent,
          specWorkerDelegationEvent(input, "2026-07-17T01:00:01.000Z"),
        ]);
      }
      if (supervisorTurn === 2) {
        const workerId = allDelegations().find((request) => request.taskId === "spec:change-one")!.id;
        return createHandle(input.sessionId, [
          specReviewControlEvent(input, {
            type: "managed_change.spec_review", changeId: "change-one", workerDelegationRequestId: workerId,
            decision: "approve", summary: "The latest spec attempt is ready to merge.",
          }, "2026-07-17T01:00:03.100Z"),
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Requesting spec review.", occurredAt: "2026-07-17T01:00:03.200Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: workerId,
              prompt: "Judge the approved spec attempt.", summary: "Judge approved spec attempt.",
            } },
          },
        ]);
      }
      if (supervisorTurn === 3) {
        statusBeforeCorrective = managedTaskRepo.getTask(input.goalId, "spec:change-one")?.status ?? null;
        return createHandle(input.sessionId, [
          specWorkerDelegationEvent(input, "2026-07-17T01:00:06.000Z"),
        ]);
      }
      return createHandle(input.sessionId, []);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
    worktreeService: {
      async createChildWorktree() { return { path: worktreePath, label: "zero-attestation-spec" }; },
      async removeWorktree() {},
    },
    worktreeAttestor: () => [],
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => specWorkerStarts === 2);

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.equal(specWorkerStarts, 2, "the safe rejection must permit a corrective spec attempt");
  assert.equal(judgeStarts, 1);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "change.spec_merged"));
  assert.equal(statusBeforeCorrective, "rejected");
  assert.equal(managedTaskRepo.getTask(fixture.goal.id, "spec:change-one")?.attemptCount, 2);
  const delivery = managedTaskRepo.listDeliveries(fixture.goal.id, "spec:change-one")[0];
  assert.equal(delivery?.status, "rejected");
  fixture.db.close();
});

test("REPRO-H5: spec retry-budget exhaustion blocks the change but keeps the goal alive", async () => {
  const fixture = createManagerFixture("repro spec budget goal survival");
  const openSpec = recordingOpenSpecService("cli", {
    validateFailures: [
      ["Requirement R1 has no WHEN/THEN scenario."],
      ["Requirement R1 has no WHEN/THEN scenario."],
    ],
  });
  const gates = [0, 1].map(() => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  });
  let sendCount = 0;
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec worker completed.", occurredAt: "2026-07-17T00:00:02.000Z" },
        ]);
      }
      if (supervisorStarted) return createHandle(input.sessionId, []);
      supervisorStarted = true;
      const specDelegation = (at: string): AgentRuntimeEvent => ({
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Delegating spec authoring.", occurredAt: at,
        metadata: { delegationControlEvent: {
          type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
          prompt: "Author change-one specs.", summary: "Author change-one specs.",
        } },
      });
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield {
            ...changePlanEvent([{ id: "change-one", title: "Change one", rationale: "Only slice." }]),
            sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          } satisfies AgentRuntimeEvent;
          yield specDelegation("2026-07-17T00:00:01.000Z");
          await gates[0]!.promise;
          yield specDelegation("2026-07-17T00:00:03.000Z");
          await gates[1]!.promise;
          yield specDelegation("2026-07-17T00:00:05.000Z");
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
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.runtimeEventType === "change.blocked"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((event) =>
    event.data.runtimeEventType === "change.blocked" && event.data.changeId === "change-one"));
  assert.ok(
    !events.some((event) => event.type === "goal.blocked"),
    "one change spec-budget exhaustion must not terminally block the whole goal",
  );
  assert.equal(
    fixture.goalRepo.getById(fixture.goal.id)?.status,
    "running",
    "the goal must stay alive so the Supervisor can reassess and re-plan the blocked scope",
  );
  fixture.db.close();
});

test("re-plans blocked spec scope through an unsatisfied reassessment and a next epoch", async () => {
  const fixture = createManagerFixture("blocked scope re-planning");
  const openSpec = recordingOpenSpecService("cli", {
    validateFailures: [
      ["Requirement R1 has no WHEN/THEN scenario."],
      ["Requirement R1 has no WHEN/THEN scenario."],
    ],
  });
  const gates = [0, 1].map(() => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  });
  let sendCount = 0;
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec worker completed.", occurredAt: "2026-07-17T03:00:02.000Z" },
        ]);
      }
      if (supervisorStarted) return createHandle(input.sessionId, []);
      supervisorStarted = true;
      const specDelegation = (at: string): AgentRuntimeEvent => ({
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Delegating spec authoring.", occurredAt: at,
        metadata: { delegationControlEvent: {
          type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
          prompt: "Author change-one specs.", summary: "Author change-one specs.",
        } },
      });
      const control = (block: Record<string, unknown>, at: string): AgentRuntimeEvent => ({
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Supervisor control block.", occurredAt: at,
        metadata: { delegationControlEvent: block },
      });
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield {
            ...changePlanEvent([{ id: "change-one", title: "Change one", rationale: "Only slice." }]),
            sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          } satisfies AgentRuntimeEvent;
          yield specDelegation("2026-07-17T03:00:01.000Z");
          await gates[0]!.promise;
          yield specDelegation("2026-07-17T03:00:03.000Z");
          await gates[1]!.promise;
          // Third delegation exhausts the budget: change blocked, goal alive.
          yield specDelegation("2026-07-17T03:00:05.000Z");
          // Forgetting the blocked scope is rejected naming the change.
          yield control({
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one spec authoring failed structurally twice and was blocked."],
            remainingGaps: [{ refs: ["new:unrelated"], summary: "Some other gap." }],
            nextEpochRationale: "Re-plan.",
          }, "2026-07-17T03:00:05.500Z");
          yield control({
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one spec authoring failed structurally twice and was blocked."],
            remainingGaps: [{ refs: ["change-one"], summary: "change-one scope is blocked and must be re-planned." }],
            nextEpochRationale: "Re-slice the blocked scope into an authorable change.",
          }, "2026-07-17T03:00:06.000Z");
          yield control({
            type: "managed_change.plan",
            changes: [{ id: "change-one-relanded", title: "Re-sliced change one", rationale: "Narrower scope." }],
          }, "2026-07-17T03:00:07.000Z");
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
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .filter((event) => event.data.runtimeEventType === "supervisor.change_plan").length === 2);

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((event) =>
    event.data.runtimeEventType === "change.blocked" && event.data.changeId === "change-one"));
  assert.ok(!events.some((event) => event.type === "goal.blocked"));
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "running");
  const unaccounted = events.find((event) =>
    event.data.runtimeEventType === "delegation.rejected" &&
    /unaccounted/i.test(String(event.data.safeReason)));
  assert.ok(unaccounted, "a reassessment omitting the blocked change must be rejected");
  assert.match(String(unaccounted.data.safeReason), /change-one/);
  const reassessment = events.find((event) => event.data.runtimeEventType === "supervisor.reassessment");
  assert.ok(reassessment, "the reassessment must be accepted with the change blocked (not archived)");
  assert.equal(reassessment.data.goalSatisfied, false);
  const plans = events.filter((event) => event.data.runtimeEventType === "supervisor.change_plan");
  assert.deepEqual(plans.map((event) => event.data.epochSequence), [1, 2]);
  assert.ok(events.some((event) =>
    event.data.runtimeEventType === "change.activated" && event.data.changeId === "change-one-relanded"));
  fixture.db.close();
});
