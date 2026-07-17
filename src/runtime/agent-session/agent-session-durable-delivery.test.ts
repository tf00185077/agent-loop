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
  createHandle,
  createManagerFixture,
  delegationRequestEvent,
  memoryWorktreeService,
  waitFor,
} from "./agent-session-test-harness.js";

test("starts a managed session consumes adapter events and updates durable session state", async () => {
  const publishedEventIds: string[] = [];
  const eventBus: EventBus = {
    publish(event) {
      publishedEventIds.push(event.id);
    },
    subscribe() {
      return () => undefined;
    },
  };
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-manager-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db, { eventBus });
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Managed runtime goal",
    description: "Exercise session manager.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const events: AgentRuntimeEvent[] = [
    {
      type: "progress",
      sessionId: "session-from-manager",
      goalId: goal.id,
      runId: "run-from-manager",
      message: "Adapter started work",
      occurredAt: "2026-06-26T00:00:01.000Z",
      metadata: { providerId: "codex-local", modelLabel: "gpt-5-codex" },
    },
    {
      type: "approval.requested",
      sessionId: "session-from-manager",
      goalId: goal.id,
      runId: "run-from-manager",
      message: "Approval requested",
      occurredAt: "2026-06-26T00:00:02.000Z",
      metadata: { approvalRequestId: "approval-1", commandId: "command-1" },
    },
    {
      type: "session.completed",
      sessionId: "session-from-manager",
      goalId: goal.id,
      runId: "run-from-manager",
      message: "Adapter completed",
      occurredAt: "2026-06-26T00:00:03.000Z",
      metadata: { providerId: "codex-local", modelLabel: "gpt-5-codex" },
    },
  ];
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: true,
        cancellation: true,
        resume: false,
        childSessions: false,
      };
    },
    async startSession(input) {
      assert.equal(input.goalId, goal.id);
      return createHandle(input.sessionId, events);
    },
  };
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    worktreeService: memoryWorktreeService(),
  });

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Do the work",
    adapter,
  });

  const session = agentSessionRepo.getSession(result.session.id);
  assert.equal(session?.lifecycleState, "completed");
  assert.equal(session?.capabilities.approval, true);
  const durableEvents = eventRepo.listForGoal(goal.id);
  assert.deepEqual(
    durableEvents.map((event) => event.type),
    ["run.started", "agent.progress", "agent.progress", "run.completed", "goal.completed"],
  );
  assert.deepEqual(publishedEventIds, durableEvents.map((event) => event.id));
  assert.equal(goalRepo.getById(goal.id)?.status, "completed");

  db.close();
});

test("runs sequential delegations across continuations and records durable task metadata", async () => {
  const fixture = createManagerFixture("sequential tasks goal");
  let supervisorTurn = 0;
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
            message: `Worker finished: ${input.prompt}`,
            occurredAt: "2026-07-06T00:00:02.000Z",
          },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Planning tasks.",
            occurredAt: "2026-07-06T00:00:01.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.task_list",
                tasks: [
                  {
                    id: "task-1",
                    title: "Implement matchmaking",
                    acceptance: [{ id: "A1", text: "Players can be matched into a lobby." }],
                  },
                  {
                    id: "task-2",
                    title: "Implement co-op mode",
                    acceptance: [{ id: "B1", text: "Two players can play the co-op mission." }],
                  },
                ],
              },
            },
          },
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Delegating task one.",
            occurredAt: "2026-07-06T00:00:01.500Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "task-1",
                prompt: "Implement matchmaking.",
                summary: "Implement matchmaking.",
              },
            },
          },
        ]);
      }
      if (supervisorTurn === 2) {
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Delegating task two.",
            occurredAt: "2026-07-06T00:00:03.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "task-2",
                prompt: "Implement co-op mode.",
                summary: "Implement co-op mode.",
              },
            },
          },
        ]);
      }
      return createHandle(input.sessionId, [
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Completing goal.",
          occurredAt: "2026-07-06T00:00:05.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.complete",
              summary: "Both game modes delivered.",
            },
          },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager(fixture);

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const taskListEvent = events.find((event) => event.data.runtimeEventType === "supervisor.task_list");
  assert.deepEqual(taskListEvent?.data.taskList, [
    {
      id: "task-1",
      title: "Implement matchmaking",
      acceptance: [{ id: "A1", text: "Players can be matched into a lobby." }],
      parentTaskId: null,
    },
    {
      id: "task-2",
      title: "Implement co-op mode",
      acceptance: [{ id: "B1", text: "Two players can play the co-op mission." }],
      parentTaskId: null,
    },
  ]);
  const accepted = events.filter((event) => event.data.runtimeEventType === "delegation.accepted");
  assert.deepEqual(
    accepted.map((event) => event.data.taskId),
    ["task-1", "task-2"],
  );
  const delegations = fixture.agentSessionRepo
    .listSessionsForGoal(fixture.goal.id)
    .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id));
  assert.deepEqual(
    delegations.map((request) => [request.taskId, request.status]),
    [
      ["task-1", "completed"],
      ["task-2", "completed"],
    ],
  );
  assert.equal(supervisorTurn, 3);
  const completion = events.find((event) => event.type === "goal.completed");
  assert.equal(completion?.message, "Both game modes delivered.");
  fixture.db.close();
});

test("downgrades incapable role assignments to the goal adapter with a durable event", async () => {
  const fixture = createManagerFixture("role assignment downgrade");
  const childStarts: string[] = [];
  let supervisorStarted = false;
  const supervisorAdapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childStarts.push(input.providerId);
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Worker finished.",
            occurredAt: "2026-07-13T06:00:02.000Z",
          },
        ]);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(input.sessionId, [
        delegationRequestEvent(input.sessionId, input.goalId, input.runId),
      ]);
    },
  };
  const incapableAdapter: AgentRuntimeAdapter = {
    providerId: "claude-local",
    async detectCapabilities() {
      return {
        eventStreaming: false,
        approval: false,
        cancellation: false,
        resume: false,
        childSessions: false,
        unsupportedReasons: { approval: "Claude print mode support could not be verified." },
      };
    },
    async startSession() {
      throw new Error("must not start on an incapable assignment");
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    roleAdapterResolver: () => ({
      adapter: incapableAdapter,
      providerId: "claude-local",
      modelLabel: "claude-sonnet-4",
    }),
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: supervisorAdapter,
    prompt: "Delegate.",
  });
  await waitFor(() => childStarts.length === 1);

  const downgrade = fixture.eventRepo
    .listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "role_assignment.downgraded");
  assert.equal(downgrade?.data.role, "worker");
  assert.match(String(downgrade?.data.reason), /could not be verified/);
  // Child ran on the goal's default adapter.
  const started = fixture.eventRepo
    .listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.started");
  assert.equal(started?.data.childProvider, "codex-local");
  fixture.db.close();
});

test("captures structured child results and attests changed files from the worktree", async () => {
  const fixture = createManagerFixture("structured result attestation");
  let supervisorStarted = false;
  const attestedPaths: string[] = [];
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Reporting structured result.",
            occurredAt: "2026-07-13T04:00:01.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_task.result",
                taskId: "task-1",
                criterionEvidence: [{ criterionId: "A1", evidence: "Second player joined in test run." }],
                tests: [{ command: "npm test -- lobby", exitCode: 0, summary: "3 passing" }],
                claimedFiles: ["src/lobby.ts", "src/matchmaking.ts"],
              },
            },
          },
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Worker done.",
            occurredAt: "2026-07-13T04:00:02.000Z",
          },
        ]);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(input.sessionId, [
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Announcing task.",
          occurredAt: "2026-07-13T04:00:00.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.task_list",
              tasks: [
                {
                  id: "task-1",
                  title: "Lobby join",
                  acceptance: [{ id: "A1", text: "Second player can join the lobby." }],
                },
              ],
            },
          },
        },
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Delegating.",
          occurredAt: "2026-07-13T04:00:00.500Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.request",
              role: "worker",
              taskId: "task-1",
              prompt: "Implement lobby join.",
            },
          },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    worktreeAttestor: (worktreePath: string) => {
      attestedPaths.push(worktreePath);
      return ["src/lobby.ts"];
    },
  });

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(
    () => fixture.agentSessionRepo.listDelegationRequests(result.session.id)[0]?.status === "completed",
  );
  await waitFor(() =>
    fixture.eventRepo.listForGoal(fixture.goal.id).some((event) => event.data.continuationMode === "fresh"),
  );

  const request = fixture.agentSessionRepo.listDelegationRequests(result.session.id)[0];
  assert.deepEqual(request?.acceptance, [{ id: "A1", text: "Second player can join the lobby." }]);
  assert.deepEqual(request?.resultSummary?.criterionEvidence, [
    { criterionId: "A1", evidence: "Second player joined in test run." },
  ]);
  assert.deepEqual(request?.resultSummary?.tests, [
    { command: "npm test -- lobby", exitCode: 0, summary: "3 passing" },
  ]);
  assert.deepEqual(request?.resultSummary?.claimedFiles, ["src/lobby.ts", "src/matchmaking.ts"]);
  assert.deepEqual(request?.resultSummary?.attestedFiles, ["src/lobby.ts"]);
  assert.equal(request?.resultSummary?.filesDiscrepancy, true);
  assert.equal(attestedPaths.length, 1);
  assert.match(attestedPaths[0] ?? "", /worktrees/i);
  const taskResultEvent = fixture.eventRepo
    .listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "task.result");
  assert.ok(taskResultEvent, "expected a durable task.result event from the child");
  fixture.db.close();
});

test("uses durable task, structured Judge, and completion gates without fixture-only merge metadata", async () => {
  const fixture = createManagerFixture("durable judge flow");
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  let supervisorTurn = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        if (input.prompt.includes("Independent Judge contract")) {
          const workerId = fixture.agentSessionRepo
            .listSessionsForGoal(fixture.goal.id)
            .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id))
            .find((request) => request.role === "worker")!.id;
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judged.", occurredAt: "2026-07-14T00:00:04.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerId, verdict: "accepted",
                decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Evidence is sufficient." }],
                safeSummary: "Criterion passes.", deferredFindings: [],
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge completed.", occurredAt: "2026-07-14T00:00:05.000Z" },
          ]);
        }
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Evidence.", occurredAt: "2026-07-14T00:00:02.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "task-1",
              criterionEvidence: [{ criterionId: "A1", evidence: "Focused test passed." }], tests: [],
              claimedFiles: ["src/change.ts"],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Worker completed.", occurredAt: "2026-07-14T00:00:03.000Z" },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Contract.", occurredAt: "2026-07-14T00:00:00.000Z",
            metadata: { delegationControlEvent: { type: "managed_delegation.task_list", tasks: [
              { id: "task-1", title: "Text-only task", acceptance: [{ id: "A1", text: "Evidence is verified." }] },
            ] } },
          },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Delegate.", occurredAt: "2026-07-14T00:00:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker", taskId: "task-1", prompt: "Do task.", summary: "Do task.",
            } },
          },
        ]);
      }
      const workerId = fixture.agentSessionRepo
        .listSessionsForGoal(fixture.goal.id)
        .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id))
        .find((request) => request.role === "worker")!.id;
      if (supervisorTurn === 2) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Premature completion.", occurredAt: "2026-07-14T00:00:03.100Z",
            metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Claimed early." } },
          },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Request judge.", occurredAt: "2026-07-14T00:00:03.200Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: workerId,
              prompt: "Judge independently.", summary: "Judge independently.",
            } },
          },
        ]);
      }
      return createHandle(input.sessionId, [{
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Complete.", occurredAt: "2026-07-14T00:00:06.000Z",
        metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Durably accepted." } },
      }]);
    },
  };
  // Proves write-ahead ordering: the pending delivery row must be durable at the
  // instant the supervisor-mutating apply runs.
  let pendingRowsAtApply = -1;
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    worktreeAttestor: () => ["src/change.ts"],
    managedDeliveryService: {
      prepareCandidate() {
        return { ok: true as const, candidateCommitSha: "candidate", checkpointHead: "base", candidateFiles: ["src/change.ts"] };
      },
      deliverCandidate() {
        pendingRowsAtApply = managedTaskRepo.listPendingDeliveries(fixture.goal.id).length;
        return {
          status: "committed", safeSummary: "Backend mock delivery committed.", checkpointHead: "base",
          checkpointStatus: "clean", candidateCommitSha: "candidate", commitSha: "delivered",
          validationCommand: "npm test", validationExitCode: 0, validationSummary: "passed", rollbackSummary: null,
        };
      },
    },
  });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  assert.equal(pendingRowsAtApply, 1, "a pending delivery row must exist before the supervisor-mutating apply");
  assert.equal(managedTaskRepo.getTask("task-1")?.status, "accepted");
  assert.equal(managedTaskRepo.listReviews("task-1")[0]?.verdict, "accepted");
  assert.equal(managedTaskRepo.listDeliveries("task-1")[0]?.status, "committed");
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((event) => event.data.completionGaps));
  assert.equal(events.find((event) => event.type === "goal.completed")?.message, "Durably accepted.");
  fixture.db.close();
});

test("dispatches Integrator and candidate-bound re-Judge immediately after backend conflict", async () => {
  const fixture = createManagerFixture("conditional integration flow");
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  const starts: string[] = [];
  let supervisorTurn = 0;
  const allDelegations = () => fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
    .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id));
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        if (input.prompt.includes("## Integrator contract")) {
          starts.push("integrator");
          const integrationId = input.prompt.match(/Integration attempt: (\S+)/)?.[1] ?? "missing";
          const workerId = input.prompt.match(/Worker attempt: (\S+)/)?.[1] ?? "missing";
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Resolved.", occurredAt: "2026-07-14T00:00:06.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_integration.result", integrationAttemptId: integrationId,
                workerDelegationRequestId: workerId, originalCandidateCommitSha: "candidate-1",
                safeSummary: "Resolved the conflict.",
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Integrator completed.", occurredAt: "2026-07-14T00:00:07.000Z" },
          ]);
        }
        if (input.prompt.includes("Independent Judge contract")) {
          const workerId = allDelegations().find((request) => request.role === "worker")!.id;
          const resolved = input.prompt.includes("Exact reviewed candidate: candidate-2");
          starts.push(resolved ? "judge-resolved" : "judge-original");
          const integrationId = input.prompt.match(/Integration attempt: (\S+)/)?.[1];
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judged.", occurredAt: "2026-07-14T00:00:04.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerId,
                ...(resolved ? { integrationAttemptId: integrationId, reviewedCandidateCommitSha: "candidate-2" } : {}),
                verdict: "accepted",
                decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Pass" }],
                safeSummary: resolved ? "Resolved candidate accepted." : "Original candidate accepted.",
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge completed.", occurredAt: "2026-07-14T00:00:05.000Z" },
          ]);
        }
        starts.push("worker");
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Evidence.", occurredAt: "2026-07-14T00:00:02.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "task-1",
              criterionEvidence: [{ criterionId: "A1", evidence: "Test passed." }], claimedFiles: ["src/change.ts"],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Worker completed.", occurredAt: "2026-07-14T00:00:03.000Z" },
        ]);
      }

      supervisorTurn += 1;
      starts.push(`supervisor-${supervisorTurn}`);
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Contract.", occurredAt: "2026-07-14T00:00:00.000Z",
            metadata: { delegationControlEvent: { type: "managed_delegation.task_list", tasks: [
              { id: "task-1", title: "Conflict task", acceptance: [{ id: "A1", text: "Final candidate passes." }] },
            ] } },
          },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Delegate.", occurredAt: "2026-07-14T00:00:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker", taskId: "task-1", prompt: "Implement.", summary: "Implement.",
            } },
          },
        ]);
      }
      if (supervisorTurn === 2) {
        const workerId = allDelegations().find((request) => request.role === "worker")!.id;
        return createHandle(input.sessionId, [{
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Request judge.", occurredAt: "2026-07-14T00:00:03.500Z",
          metadata: { delegationControlEvent: {
            type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: workerId,
            prompt: "Judge.", summary: "Judge.",
          } },
        }]);
      }
      return createHandle(input.sessionId, [{
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Complete.", occurredAt: "2026-07-14T00:00:09.000Z",
        metadata: { delegationControlEvent: { type: "managed_delegation.complete", summary: "Integrated." } },
      }]);
    },
  };

  let cleaned = 0;
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    worktreeAttestor: () => ["src/change.ts"],
    managedDeliveryService: (() => {
      let applyCount = 0;
      return {
        prepareCandidate() {
          return { ok: true as const, candidateCommitSha: "candidate-1", checkpointHead: "base", candidateFiles: ["src/change.ts"] };
        },
        deliverCandidate() {
          applyCount += 1;
          // First apply is the normal delivery (conflicts → integration recovery);
          // the second is the resolved candidate after the integrator.
          return applyCount === 1
            ? {
                status: "conflict" as const, safeSummary: "Candidate conflicted; checkpoint restored.", checkpointHead: "base",
                checkpointStatus: "clean", candidateCommitSha: "candidate-1", commitSha: null,
                validationCommand: null, validationExitCode: null, validationSummary: null,
                rollbackSummary: "restored", candidateFiles: ["src/change.ts"], conflictFiles: ["src/change.ts"],
                conflictSummary: "CONFLICT src/change.ts",
              }
            : {
                status: "committed" as const, safeSummary: "Resolved candidate committed.", checkpointHead: "base",
                checkpointStatus: "clean", candidateCommitSha: "candidate-2", commitSha: "delivered-2",
                validationCommand: "npm test", validationExitCode: 0, validationSummary: "passed", rollbackSummary: null,
              };
        },
      };
    })(),
    managedIntegrationService: {
      async prepare() {
        return { ok: true as const, worktree: { path: "C:\\integration", label: "integration-1" },
          conflictFiles: ["src/change.ts"], allowedFiles: ["src/change.ts"] };
      },
      verifyAndCreateCandidate() {
        return { ok: true as const, resolvedCandidateCommitSha: "candidate-2", changedFiles: ["src/change.ts"],
          safeSummary: "Resolved candidate created." };
      },
      async cleanup() { cleaned += 1; },
    },
  });
  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  assert.deepEqual(starts, [
    "supervisor-1", "worker", "supervisor-2", "judge-original", "integrator", "judge-resolved", "supervisor-3",
  ]);
  assert.deepEqual(allDelegations().map((request) => request.role), ["worker", "review_merge", "integrator", "review_merge"]);
  assert.equal(managedTaskRepo.listIntegrations("task-1")[0]?.status, "committed");
  assert.equal(managedTaskRepo.listReviews("task-1").at(-1)?.reviewedCandidateCommitSha, "candidate-2");
  assert.equal(managedTaskRepo.listDeliveries("task-1")[0]?.commitSha, "delivered-2");
  assert.equal(cleaned, 1);
  fixture.db.close();
});

test("executes checked criteria in the worker worktree before the judge and persists execution records", async () => {
  const fixture = createManagerFixture("check execution goal");
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  const runnerCalls: Array<{ cwd: string; command: string; timeoutMs: number }> = [];
  const judgePrompts: string[] = [];
  let supervisorTurn = 0;
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
          judgePrompts.push(input.prompt);
          const workerId = allDelegations().find((request) => request.taskId === "task-1")!.id;
          return createHandle(input.sessionId, [
            {
              type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judged.", occurredAt: "2026-07-18T00:00:04.000Z",
              metadata: { delegationControlEvent: {
                type: "managed_review.decision", workerDelegationRequestId: workerId, verdict: "accepted",
                decisions: [{ criterionId: "A1", outcome: "PASS", safeSummary: "Check passed." }],
                safeSummary: "Accepted.", deferredFindings: [],
              } },
            },
            { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Judge complete.", occurredAt: "2026-07-18T00:00:05.000Z" },
          ]);
        }
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Result.", occurredAt: "2026-07-18T00:00:02.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_task.result", taskId: "task-1",
              criterionEvidence: [{ criterionId: "A1", evidence: "Implemented and tested." }],
              claimedFiles: ["src/notes.js"], tests: [],
            } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Worker complete.", occurredAt: "2026-07-18T00:00:03.000Z" },
        ]);
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Announce.", occurredAt: "2026-07-18T00:00:00.500Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.task_list",
              tasks: [{
                id: "task-1", title: "Notes storage",
                acceptance: [{
                  id: "A1", text: "Storage round-trips notes.",
                  check: { kind: "command", command: "node --test tests/notes.test.js", timeoutMs: 30000 },
                }],
              }],
            } },
          },
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Delegate.", occurredAt: "2026-07-18T00:00:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker", taskId: "task-1",
              prompt: "Implement notes storage.", summary: "Implement notes storage.",
            } },
          },
        ]);
      }
      if (supervisorTurn === 2) {
        const workerId = allDelegations().find((request) => request.taskId === "task-1")!.id;
        return createHandle(input.sessionId, [{
          type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          message: "Review.", occurredAt: "2026-07-18T00:00:03.500Z",
          metadata: { delegationControlEvent: {
            type: "managed_delegation.request", role: "review_merge", workerDelegationRequestId: workerId,
            prompt: "Judge the result.", summary: "Judge the result.",
          } },
        }]);
      }
      return createHandle(input.sessionId, []);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    supervisorCwd: "C:\\goal-workspace",
    worktreeAttestor: () => ["src/notes.js"],
    checkRunner: {
      async run(input) {
        runnerCalls.push(input);
        return { exitCode: 0, durationMs: 42, outputSummary: "1 passing", failedToRun: false };
      },
    },
    managedDeliveryService: {
      prepareCandidate() {
        return { ok: true as const, candidateCommitSha: "candidate", checkpointHead: "base",
          candidateFiles: ["src/notes.js"] };
      },
      deliverCandidate() {
        return { status: "committed" as const, safeSummary: "Delivered.", checkpointHead: "base",
          checkpointStatus: "clean" as const, candidateCommitSha: "candidate", commitSha: "delivered",
          validationCommand: "npm test", validationExitCode: 0, validationSummary: "passed", rollbackSummary: null };
      },
    },
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => managedTaskRepo.getTask(fixture.goal.id, "task-1")?.status === "accepted");

  const workerId = allDelegations().find((request) => request.taskId === "task-1")!.id;
  assert.equal(runnerCalls.length, 1, "the backend must execute the check exactly once");
  assert.match(runnerCalls[0]!.cwd, /^C:\\worktrees\\/, "checks run in the worker worktree");
  assert.equal(runnerCalls[0]!.command, "node --test tests/notes.test.js");
  assert.equal(runnerCalls[0]!.timeoutMs, 30000);

  const executions = managedTaskRepo.listCheckExecutions(workerId);
  assert.equal(executions.length, 1);
  assert.equal(executions[0]!.criterionId, "A1");
  assert.equal(executions[0]!.exitCode, 0);
  assert.equal(executions[0]!.target, "candidate");
  assert.equal(executions[0]!.outputSummary, "1 passing");

  assert.equal(judgePrompts.length, 1);
  assert.match(judgePrompts[0]!, /## Executed acceptance checks/);
  assert.match(judgePrompts[0]!, /A1.*exit 0/s);
  fixture.db.close();
});
