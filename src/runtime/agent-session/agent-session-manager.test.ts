import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
import type { OpenSpecWorkspaceService } from "./openspec-workspace-service.js";

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

test("recovers orphaned non-terminal sessions as stalled visible state", () => {
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
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-recovery-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db, { eventBus });
  const agentSessionRepo = createAgentSessionRepository(db, {
    now: fixedClock([
      "2026-06-26T00:00:00.000Z",
      "2026-06-26T00:00:01.000Z",
      "2026-06-26T00:05:00.000Z",
      "2026-06-26T00:05:01.000Z",
    ]),
  });
  const goal = goalRepo.create({
    title: "Recover orphaned session",
    description: "Backend restarted while adapter was running.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const run = runRepo.create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const running = agentSessionRepo.createSession({
    goalId: goal.id,
    runId: run.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "running",
    capabilities: {
      eventStreaming: true,
      approval: true,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
  });
  const terminalRun = runRepo.create({ goalId: goal.id, provider: "codex-local", model: "gpt-5-codex" });
  const completed = agentSessionRepo.createSession({
    goalId: goal.id,
    runId: terminalRun.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    lifecycleState: "completed",
    capabilities: {
      eventStreaming: true,
      approval: true,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
  });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    worktreeService: memoryWorktreeService(),
  });

  const recovered = manager.recoverOrphanedSessions();

  assert.deepEqual(recovered.map((session) => session.id), [running.id]);
  assert.equal(agentSessionRepo.getSession(running.id)?.lifecycleState, "stalled");
  assert.equal(agentSessionRepo.getSession(completed.id)?.lifecycleState, "completed");
  const recoveryEvent = eventRepo
    .listForGoal(goal.id)
    .find((event) => event.type === "error" && event.data.sessionId === running.id);
  assert.ok(recoveryEvent);
  assert.match(recoveryEvent.message, /lost adapter control/i);
  assert.equal(runRepo.getById(run.id)?.status, "failed");
  assert.equal(goalRepo.getById(goal.id)?.status, "failed");
  assert.deepEqual(publishedEventIds, eventRepo.listForGoal(goal.id).map((event) => event.id));

  db.close();
});

test("forwards approve reject and cancel controls to the active adapter exactly once", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-controls-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Control active adapter",
    description: "Adapter controls should be idempotent.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-06-26T00:00:00.000Z" });
  const controls: string[] = [];
  let startedSessionId = "";
  let releaseEvents!: () => void;
  const eventsReleased = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });
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
      startedSessionId = input.sessionId;
      return {
        sessionId: input.sessionId,
        capabilities: {
          eventStreaming: true,
          approval: true,
          cancellation: true,
          resume: false,
          childSessions: false,
        },
        async *events() {
          yield {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Waiting for controls",
            occurredAt: "2026-06-26T00:00:01.000Z",
          } satisfies AgentRuntimeEvent;
          await eventsReleased;
          yield {
            type: "session.cancelled",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Cancelled",
            occurredAt: "2026-06-26T00:00:02.000Z",
          } satisfies AgentRuntimeEvent;
        },
        async send() {},
        async approve(requestId) {
          controls.push(`approve:${requestId}`);
        },
        async reject(requestId) {
          controls.push(`reject:${requestId}`);
        },
        async cancel() {
          controls.push("cancel");
          releaseEvents();
        },
      };
    },
  };
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    worktreeService: memoryWorktreeService(),
  });

  const running = manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Wait for controls",
    adapter,
  });
  await waitFor(() => startedSessionId.length > 0);

  assert.equal(await manager.approve(startedSessionId, "approval-1"), true);
  assert.equal(await manager.approve(startedSessionId, "approval-1"), false);
  assert.equal(await manager.reject(startedSessionId, "approval-2", "No"), true);
  assert.equal(await manager.reject(startedSessionId, "approval-2", "No"), false);
  assert.equal(await manager.cancel(startedSessionId, "Stop"), true);
  assert.equal(await manager.cancel(startedSessionId, "Stop"), false);
  await running;

  assert.deepEqual(controls, ["approve:approval-1", "reject:approval-2", "cancel"]);

  db.close();
});

test("persists valid delegation control events and starts a child claim", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-delegation-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Delegating supervisor",
    description: "Validate a structured worker request.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-03T00:00:00.000Z" });
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
    prompt: "Delegate safely.",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: goal.id,
        runId: "run-placeholder",
        message: "Requesting a worker.",
        occurredAt: "2026-07-03T00:00:01.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.request",
            role: "worker",
            prompt: "Run focused tests.",
            summary: "Run focused tests.",
          },
        },
      },
      terminalEvent(goal.id),
    ]),
  });

  const delegations = agentSessionRepo.listDelegationRequests(result.session.id);
  const durableEvents = eventRepo.listForGoal(goal.id);

  assert.equal(delegations.length, 1);
  assert.equal(delegations[0]?.status, "running");
  assert.equal(delegations[0]?.role, "worker");
  assert.equal(delegations[0]?.promptSummary, "Run focused tests.");
  assert.equal(typeof delegations[0]?.childSessionId, "string");
  assert.ok(
    durableEvents.some(
      (event) =>
        event.type === "agent.progress" &&
        event.data.runtimeEventType === "delegation.accepted" &&
        event.data.delegationRequestId === delegations[0]?.id,
    ),
  );

  db.close();
});

test("rejects duplicate active delegation control events durably", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-duplicate-delegation-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Duplicate delegation",
    description: "Only one active child is allowed.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-03T00:00:00.000Z" });
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    worktreeService: memoryWorktreeService(),
  });
  const controlEvent = {
    type: "managed_delegation.request",
    role: "worker",
    prompt: "Run focused tests.",
    summary: "Run focused tests.",
  };

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Try duplicate delegation.",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: goal.id,
        runId: "run-placeholder",
        message: "Requesting a worker.",
        occurredAt: "2026-07-03T00:00:01.000Z",
        metadata: { delegationControlEvent: controlEvent },
      },
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: goal.id,
        runId: "run-placeholder",
        message: "Requesting another worker.",
        occurredAt: "2026-07-03T00:00:02.000Z",
        metadata: { delegationControlEvent: controlEvent },
      },
      terminalEvent(goal.id),
    ]),
  });

  const delegations = agentSessionRepo.listDelegationRequests(result.session.id);
  const rejection = eventRepo
    .listForGoal(goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.rejected");

  assert.equal(delegations.length, 1);
  assert.equal(delegations[0]?.status, "running");
  assert.match(String(rejection?.data.safeReason), /active delegation/i);

  db.close();
});

test("spawns worker children in isolated worktrees and records child failure without failing the supervisor goal", async () => {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-child-failure-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({
    title: "Child failure observation",
    description: "A failed worker should not fail the supervisor automatically.",
  });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-03T00:00:00.000Z" });
  const starts: Array<{ sessionId: string; parentSessionId?: string | null; prompt: string; cwd?: string | null }> = [];
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: true,
      };
    },
    async startSession(input) {
      starts.push({
        sessionId: input.sessionId,
        parentSessionId: input.parent?.sessionId ?? null,
        prompt: input.prompt,
        cwd: input.cwd ?? null,
      });
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.failed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Worker could not complete focused tests.",
            occurredAt: "2026-07-03T00:00:02.000Z",
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
          message: "Requesting worker.",
          occurredAt: "2026-07-03T00:00:01.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.request",
              role: "worker",
              prompt: "Run focused tests.",
              summary: "Run focused tests.",
            },
          },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    worktreeService: {
      async createChildWorktree(input) {
        return { path: `C:\\worktrees\\${input.childSessionId}`, label: `child-${input.childSessionId}` };
      },
    },
    supervisorCwd: "C:\\supervisor",
  });

  const result = await manager.startManagedSession({
    goalId: goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Delegate to a worker.",
    adapter,
  });
  await waitFor(() => agentSessionRepo.listDelegationRequests(result.session.id)[0]?.status === "failed");
  await waitFor(() => starts.length === 3);
  await waitFor(() =>
    eventRepo.listForGoal(goal.id).some((event) => event.data.continuationMode === "fresh"),
  );
  const delegations = agentSessionRepo.listDelegationRequests(result.session.id);
  const durableEvents = eventRepo.listForGoal(goal.id);

  assert.equal(starts.length, 3);
  assert.equal(starts[1]?.parentSessionId, result.session.id);
  assert.equal(starts[1]?.prompt, "Run focused tests.");
  assert.equal(starts[1]?.cwd, `C:\\worktrees\\${starts[1]?.sessionId}`);
  assert.ok(starts[2]?.prompt.includes("Worker result: Worker could not complete focused tests."));
  assert.ok(starts[2]?.prompt.includes("auto-agent-control"));
  assert.deepEqual(agentSessionRepo.getSession(starts[1]!.sessionId)?.worktree, {
    path: `C:\\worktrees\\${starts[1]?.sessionId}`,
    label: `child-${starts[1]?.sessionId}`,
  });
  // The fresh continuation session supersedes the original supervisor session.
  assert.equal(agentSessionRepo.getSession(result.session.id)?.lifecycleState, "completed");
  assert.equal(delegations[0]?.status, "failed");
  assert.equal(delegations[0]?.resultSummary?.safeSummary, "Worker could not complete focused tests.");
  assert.deepEqual(delegations.map((delegation) => delegation.role), ["worker"]);
  assert.equal(goalRepo.getById(goal.id)?.status, "running");
  assert.ok(durableEvents.some((event) => event.data.runtimeEventType === "delegation.waiting_child"));
  assert.ok(durableEvents.some((event) => event.data.runtimeEventType === "delegation.failed"));

  db.close();
});

test("spawns review merge children only after a worker result exists", async () => {
  const fixture = createManagerFixture("review merge request");
  const starts: Array<{ parent?: string | null; prompt: string; cwd?: string | null }> = [];
  let workerDelegationRequestId = "";
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      starts.push({ parent: input.parent?.sessionId ?? null, prompt: input.prompt, cwd: input.cwd ?? null });
      if (!input.parent?.sessionId && supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      if (!input.parent?.sessionId) {
        supervisorStarted = true;
        const childRun = fixture.runRepo.create({
          goalId: input.goalId,
          provider: "codex-local",
          model: "gpt-5-codex",
        });
        const child = fixture.agentSessionRepo.createSession({
          goalId: input.goalId,
          runId: childRun.id,
          providerId: "codex-local",
          modelLabel: "gpt-5-codex",
          lifecycleState: "completed",
          capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: false },
          parent: { sessionId: input.sessionId },
        });
        const request = fixture.agentSessionRepo.createDelegationRequest({
          parentSessionId: input.sessionId,
          role: "worker",
          promptSummary: "Implement focused change.",
        });
        fixture.agentSessionRepo.acceptDelegationRequest(request.id);
        fixture.agentSessionRepo.startDelegationRequest(request.id, child.id);
        workerDelegationRequestId = fixture.agentSessionRepo.completeDelegationRequest(request.id, {
          kind: "success",
          safeSummary: "Worker produced a patch.",
        }).id;
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Requesting review merge.",
            occurredAt: "2026-07-03T00:00:03.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "review_merge",
                prompt: "Review and merge worker output.",
                summary: "Review worker output.",
                workerDelegationRequestId,
              },
            },
          },
        ]);
      }
      return createHandle(input.sessionId, [
        {
          type: "session.completed",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Review merge applied worker output.",
          occurredAt: "2026-07-03T00:00:04.000Z",
          metadata: {
            reviewMergeApplyOutcome: {
              status: "merged",
              diffSummary: "2 files changed, 8 insertions(+).",
              safeSummary: "Applied cleanly.",
            },
          },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({ ...fixture, supervisorCwd: "C:\\supervisor" });

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Review worker.",
    adapter,
  });
  await waitFor(() => fixture.agentSessionRepo.listDelegationRequests(result.session.id)[1]?.status === "completed");
  await waitFor(() =>
    fixture.eventRepo.listForGoal(fixture.goal.id).some((event) => event.data.continuationMode === "fresh"),
  );

  const delegations = fixture.agentSessionRepo.listDelegationRequests(result.session.id);
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.deepEqual(delegations.map((delegation) => delegation.role), ["worker", "review_merge"]);
  assert.equal(delegations[1]?.status, "completed");
  assert.equal(starts[1]?.cwd, "C:\\supervisor");
  assert.equal(starts[1]?.prompt, "Review and merge worker output.");
  assert.match(delegations[1]?.promptSummary ?? "", /Worker produced a patch/);
  assert.ok(
    events.some(
      (event) =>
        event.data.runtimeEventType === "delegation.started" &&
        JSON.stringify(event.data.reviewMergeCheckpoint).includes("checkpoint-head"),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.data.runtimeEventType === "review_merge.apply_outcome" &&
        event.data.reviewMergeOutcome === "merged" &&
        event.data.diffSummary === "2 files changed, 8 insertions(+)." &&
        JSON.stringify(event.data.fixedTest).includes("npm run typecheck"),
    ),
  );
  fixture.db.close();
});

test("rejects review merge requests when no worker result exists", async () => {
  const fixture = createManagerFixture("review merge missing worker");
  const manager = createAgentSessionManager(fixture);

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Review missing worker.",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Requesting review merge.",
        occurredAt: "2026-07-03T00:00:01.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.request",
            role: "review_merge",
            prompt: "Review missing worker.",
            summary: "Review missing worker.",
            workerDelegationRequestId: "missing-worker-result",
          },
        },
      },
      terminalEvent(fixture.goal.id),
    ]),
  });

  await waitFor(() =>
    fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .some((event) => event.data.runtimeEventType === "delegation.continuation_started"),
  );
  const rejection = fixture.eventRepo
    .listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.equal(fixture.agentSessionRepo.listDelegationRequests(result.session.id).length, 0);
  assert.match(String(rejection?.data.safeReason), /existing worker result/i);
  fixture.db.close();
});

test("rejects review merge before spawn when supervisor workspace is dirty", async () => {
  const fixture = createManagerFixture("review merge dirty workspace");
  let reviewMergeChildStarted = false;
  const manager = createAgentSessionManager({
    ...fixture,
    reviewMergeWorkspaceService: {
      async prepareReviewMerge() {
        return { ok: false, safeReason: "Supervisor workspace is dirty: M src/file.ts" };
      },
    },
  });

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Review dirty workspace.",
    adapter: adapterWithSeededReviewMergeRequest(fixture, {
      onReviewMergeStart() {
        reviewMergeChildStarted = true;
      },
    }),
  });

  const delegations = fixture.agentSessionRepo.listDelegationRequests(result.session.id);
  const rejection = fixture.eventRepo
    .listForGoal(fixture.goal.id)
    .find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.deepEqual(delegations.map((delegation) => delegation.role), ["worker"]);
  assert.equal(reviewMergeChildStarted, false);
  assert.match(String(rejection?.data.safeReason), /dirty/i);
  fixture.db.close();
});

test("records reverted and verification-failure outcomes from fixed test evidence", async () => {
  const failedFixture = createManagerFixture("review merge test failure");
  const failedManager = createAgentSessionManager({
    ...failedFixture,
    reviewMergeVerificationService: {
      verifyMerged() {
        return {
          outcome: "test_failed_reverted",
          fixedTest: { command: "npm test", exitCode: 1, outputSummary: "failed tests" },
          revertEvidence: { verified: true, summary: "Workspace reverted to pre-merge checkpoint." },
          safeSummary: "Fixed review-merge test failed; workspace revert verified.",
        };
      },
    },
  });

  await failedManager.startManagedSession({
    goalId: failedFixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Review worker.",
    adapter: adapterWithSeededReviewMergeRequest(failedFixture, {
      reviewMergeOutcome: { status: "merged", diffSummary: "1 file changed.", safeSummary: "Applied." },
    }),
  });
  await waitFor(() =>
    failedFixture.eventRepo
      .listForGoal(failedFixture.goal.id)
      .some((event) => event.data.reviewMergeOutcome === "test_failed_reverted"),
  );
  await waitFor(() =>
    failedFixture.eventRepo
      .listForGoal(failedFixture.goal.id)
      .some((event) => event.data.continuationMode === "fresh"),
  );
  const reverted = failedFixture.eventRepo
    .listForGoal(failedFixture.goal.id)
    .find((event) => event.data.reviewMergeOutcome === "test_failed_reverted");
  assert.equal((reverted?.data.revertEvidence as { verified?: boolean } | undefined)?.verified, true);
  failedFixture.db.close();

  const verificationFixture = createManagerFixture("review merge verification failure");
  const verificationManager = createAgentSessionManager({
    ...verificationFixture,
    reviewMergeVerificationService: {
      verifyMerged() {
        return {
          outcome: "verification_failed",
          fixedTest: { command: "npm test", exitCode: null, outputSummary: "spawn failed" },
          revertEvidence: null,
          safeSummary: "Fixed review-merge test command could not be verified.",
        };
      },
    },
  });

  await verificationManager.startManagedSession({
    goalId: verificationFixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Review worker.",
    adapter: adapterWithSeededReviewMergeRequest(verificationFixture, {
      reviewMergeOutcome: { status: "merged", diffSummary: "1 file changed.", safeSummary: "Applied." },
    }),
  });
  await waitFor(() =>
    verificationFixture.eventRepo
      .listForGoal(verificationFixture.goal.id)
      .some((event) => event.data.reviewMergeOutcome === "verification_failed"),
  );
  await waitFor(() =>
    verificationFixture.eventRepo
      .listForGoal(verificationFixture.goal.id)
      .some((event) => event.data.continuationMode === "fresh"),
  );
  verificationFixture.db.close();
});

test("resumes a live supervisor after child completion when resume is supported", async () => {
  const fixture = createManagerFixture("resume supervisor");
  const resumed: string[] = [];
  let releaseParent!: () => void;
  let supervisorStarted = false;
  const parentReleased = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (!input.parent?.sessionId && supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      if (!input.parent?.sessionId) {
        supervisorStarted = true;
      }
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Worker finished.",
            occurredAt: "2026-07-03T00:00:02.000Z",
          },
        ]);
      }
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield delegationRequestEvent(input.sessionId, input.goalId, input.runId);
          await parentReleased;
          yield {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Supervisor finished.",
            occurredAt: "2026-07-03T00:00:03.000Z",
          } satisfies AgentRuntimeEvent;
        },
        async send(message) {
          resumed.push(message.message ?? "");
          releaseParent();
        },
      };
    },
  };
  const manager = createAgentSessionManager(fixture);

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Delegate.",
    adapter,
  });

  assert.equal(resumed.length, 1);
  assert.match(resumed[0]!, /^Worker result: Worker finished\. \[workerDelegationRequestId: [0-9a-f-]+\]$/);
  assert.ok(fixture.eventRepo.listForGoal(fixture.goal.id).some((event) => event.data.continuationMode === "resume"));
  await waitFor(() =>
    fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .some((event) => event.data.continuationReason === "completionless_exit"),
  );
  fixture.db.close();
});

test("starts a fresh supervisor continuation when true resume is unavailable", async () => {
  const fixture = createManagerFixture("fresh continuation");
  const starts: Array<{ parent?: string | null; prompt: string }> = [];
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      starts.push({ parent: input.parent?.sessionId ?? null, prompt: input.prompt });
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Worker finished.",
            occurredAt: "2026-07-03T00:00:02.000Z",
          },
        ]);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(input.sessionId, [delegationRequestEvent(input.sessionId, input.goalId, input.runId)]);
    },
  };
  const manager = createAgentSessionManager(fixture);

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Delegate.",
    adapter,
  });
  await waitFor(() => starts.length === 3);
  await waitFor(() =>
    fixture.eventRepo.listForGoal(fixture.goal.id).some((event) => event.data.continuationMode === "fresh"),
  );

  assert.ok(starts[2]?.prompt.includes("Worker result: Worker finished."));
  assert.ok(starts[2]?.prompt.includes("auto-agent-control"));
  fixture.db.close();
});

test("leaves children running after supervisor cancellation and detaches late child results", async () => {
  const fixture = createManagerFixture("cancel supervisor with child");
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let parentSessionId = "";
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return {
          ...createHandle(input.sessionId, []),
          async *events() {
            await childReleased;
            yield {
              type: "session.completed",
              sessionId: input.sessionId,
              goalId: input.goalId,
              runId: input.runId,
              message: "Late worker result.",
              occurredAt: "2026-07-03T00:00:04.000Z",
            } satisfies AgentRuntimeEvent;
          },
        };
      }
      parentSessionId = input.sessionId;
      return createHandle(input.sessionId, [
        delegationRequestEvent(input.sessionId, input.goalId, input.runId),
        {
          type: "session.cancelled",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Supervisor cancelled.",
          occurredAt: "2026-07-03T00:00:03.000Z",
        },
      ]);
    },
  };
  const manager = createAgentSessionManager(fixture);

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    prompt: "Delegate.",
    adapter,
  });
  assert.equal(fixture.agentSessionRepo.listDelegationRequests(parentSessionId)[0]?.status, "running");
  releaseChild();
  await waitFor(() => fixture.agentSessionRepo.listDelegationRequests(parentSessionId)[0]?.status === "detached");

  assert.equal(fixture.agentSessionRepo.listDelegationRequests(parentSessionId)[0]?.detachedReason?.includes("terminal"), true);
  assert.ok(fixture.eventRepo.listForGoal(fixture.goal.id).some((event) => event.data.runtimeEventType === "delegation.detached"));
  fixture.db.close();
});

test("completes a managed goal only on a supervisor completion control block", async () => {
  const fixture = createManagerFixture("explicit completion");
  const manager = createAgentSessionManager(fixture);

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Signalling completion.",
        occurredAt: "2026-07-06T00:00:01.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.complete",
            summary: "All tasks delivered.",
          },
        },
      },
      terminalEvent(fixture.goal.id),
    ]),
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const completion = events.find((event) => event.type === "goal.completed");
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "completed");
  assert.equal(completion?.message, "All tasks delivered.");
  assert.equal(completion?.data.runtimeEventType, "supervisor.completed");
  assert.ok(!events.some((event) => event.data.runtimeEventType === "delegation.continuation_started"));
  fixture.db.close();
});

test("starts bounded nudge continuations and blocks the goal when exhausted", async () => {
  const fixture = createManagerFixture("completionless supervisor");
  const starts: string[] = [];
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      starts.push(input.prompt);
      return createHandle(input.sessionId, [
        {
          type: "session.completed",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Turn ended without completion.",
          occurredAt: "2026-07-06T00:00:01.000Z",
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({ ...fixture, maxSupervisorContinuations: 2 });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "blocked");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.equal(starts.length, 3);
  assert.ok(/continue or complete/i.test(starts[1] ?? ""));
  assert.equal(
    events.filter((event) => event.data.continuationReason === "completionless_exit").length,
    2,
  );
  const blocked = events.find((event) => event.type === "goal.blocked");
  assert.equal(blocked?.data.runtimeEventType, "supervisor.continuations_exhausted");
  assert.equal(blocked?.data.maxSupervisorContinuations, 2);
  fixture.db.close();
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

test("continues the supervisor when its process exits while a child is still running", async () => {
  const fixture = createManagerFixture("supervisor exits while child runs");
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const starts: Array<{ parent?: string | null; prompt: string }> = [];
  let supervisorTurn = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      starts.push({ parent: input.parent?.sessionId ?? null, prompt: input.prompt });
      if (input.parent?.sessionId) {
        return {
          ...createHandle(input.sessionId, []),
          async *events() {
            await childReleased;
            yield {
              type: "session.completed",
              sessionId: input.sessionId,
              goalId: input.goalId,
              runId: input.runId,
              message: "Worker delivered the task.",
              occurredAt: "2026-07-13T00:00:02.000Z",
            } satisfies AgentRuntimeEvent;
          },
        };
      }
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        // Fresh-continuation providers exit their process after delegating.
        return createHandle(input.sessionId, [
          delegationRequestEvent(input.sessionId, input.goalId, input.runId),
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Supervisor turn ended while waiting.",
            occurredAt: "2026-07-13T00:00:01.000Z",
          },
        ]);
      }
      return createHandle(input.sessionId, [
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Completing after worker result.",
          occurredAt: "2026-07-13T00:00:03.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.complete",
              summary: "Task delivered by worker.",
            },
          },
        },
      ]);
    },
  };
  const manager = createAgentSessionManager(fixture);

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  // Supervisor process exited but its delegation is still active.
  assert.equal(fixture.agentSessionRepo.getSession(result.session.id)?.lifecycleState, "waiting_child");
  releaseChild();
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "completed");

  const delegations = fixture.agentSessionRepo.listDelegationRequests(result.session.id);
  assert.equal(delegations[0]?.status, "completed");
  assert.notEqual(delegations[0]?.status, "detached");
  assert.ok(starts[2]?.prompt.includes("Worker result: Worker delivered the task."));
  assert.equal(fixture.agentSessionRepo.getSession(result.session.id)?.lifecycleState, "completed");
  fixture.db.close();
});

test("enforces acceptance contracts on worker delegations", async () => {
  const fixture = createManagerFixture("acceptance contract enforcement");
  const manager = createAgentSessionManager(fixture);

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Announcing tasks.",
        occurredAt: "2026-07-13T01:00:00.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.task_list",
            tasks: [{ id: "task-1", title: "No contract yet" }],
          },
        },
      },
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Delegating without a contract.",
        occurredAt: "2026-07-13T01:00:01.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.request",
            role: "worker",
            taskId: "task-1",
            prompt: "Do the task.",
          },
        },
      },
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Ad-hoc delegation.",
        occurredAt: "2026-07-13T01:00:02.000Z",
        metadata: {
          delegationControlEvent: {
            type: "managed_delegation.request",
            role: "worker",
            prompt: "Quick side errand.",
          },
        },
      },
      {
        type: "progress",
        sessionId: "session-placeholder",
        goalId: fixture.goal.id,
        runId: "run-placeholder",
        message: "Completing.",
        occurredAt: "2026-07-13T01:00:03.000Z",
        metadata: {
          delegationControlEvent: { type: "managed_delegation.complete", summary: "Done." },
        },
      },
      terminalEvent(fixture.goal.id),
    ]),
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejection = events.find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.match(String(rejection?.data.safeReason), /no acceptance contract/i);
  const accepted = events.filter((event) => event.data.runtimeEventType === "delegation.accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.data.uncontracted, true);
  const requests = fixture.agentSessionRepo.listDelegationRequests(result.session.id);
  assert.equal(requests.length, 1);
  fixture.db.close();
});

test("refuses the third identical-scope retry and accepts a narrower split", async () => {
  const fixture = createManagerFixture("narrowing rule");
  let supervisorTurn = 0;
  const workerPrompts: string[] = [];
  const supervisorPrompts: string[] = [];
  const acceptance = [{ id: "A1", text: "Second player can join the lobby." }];
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        workerPrompts.push(input.prompt);
      } else {
        supervisorPrompts.push(input.prompt);
      }
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Worker claims the task is done.",
            occurredAt: "2026-07-13T02:00:02.000Z",
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
            message: "Planning.",
            occurredAt: "2026-07-13T02:00:00.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.task_list",
                tasks: [{ id: "task-1", title: "Lobby join", acceptance }],
              },
            },
          },
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "First attempt.",
            occurredAt: "2026-07-13T02:00:01.000Z",
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
      }
      if (supervisorTurn === 2 || supervisorTurn === 3) {
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: `Retry ${supervisorTurn}.`,
            occurredAt: "2026-07-13T02:00:03.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "task-1",
                prompt: "Retry: criterion A1 is still failing — the second player cannot join.",
              },
            },
          },
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Turn ended.",
            occurredAt: "2026-07-13T02:00:04.000Z",
          },
        ]);
      }
      if (supervisorTurn === 4) {
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Splitting the failed task.",
            occurredAt: "2026-07-13T02:00:05.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.task_list",
                tasks: [
                  {
                    id: "task-1a",
                    title: "Second player join only",
                    acceptance,
                    parentTaskId: "task-1",
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
            message: "Delegating the narrower task.",
            occurredAt: "2026-07-13T02:00:06.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "task-1a",
                prompt: "Only make the second player join work.",
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
          message: "Completing.",
          occurredAt: "2026-07-13T02:00:07.000Z",
          metadata: {
            delegationControlEvent: { type: "managed_delegation.complete", summary: "Narrow task landed." },
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
  const rejections = events.filter((event) => event.data.runtimeEventType === "task.rejection_recorded");
  assert.equal(rejections.length, 2);
  assert.deepEqual(rejections[0]?.data.citedCriteria, ["A1"]);
  const refusal = events.find(
    (event) =>
      event.data.runtimeEventType === "delegation.rejected" && /split/i.test(String(event.data.safeReason)),
  );
  assert.ok(refusal, "expected the third identical-scope retry to be refused with a split instruction");
  const acceptedTaskIds = events
    .filter((event) => event.data.runtimeEventType === "delegation.accepted")
    .map((event) => event.data.taskId);
  assert.deepEqual(acceptedTaskIds, ["task-1", "task-1", "task-1a"]);
  const splitList = events.filter((event) => event.data.runtimeEventType === "supervisor.task_list").at(-1);
  assert.equal(
    (splitList?.data.taskList as Array<{ parentTaskId?: string | null }>)[0]?.parentTaskId,
    "task-1",
  );
  // Workers receive the frozen contract appendix with the result-block format.
  assert.ok(workerPrompts[0]?.includes("- A1: Second player can join the lobby."));
  assert.ok(workerPrompts[0]?.includes("managed_task.result"));
  // The post-refusal nudge continuation carries the durable task history.
  const historyPrompts = supervisorPrompts.filter((prompt) => prompt.includes("## Task history"));
  assert.ok(historyPrompts.length > 0, "expected continuation prompts carrying the task history");
  const nudgePrompt = historyPrompts.at(-1);
  assert.ok(nudgePrompt?.includes("task-1"));
  assert.ok(nudgePrompt?.includes("rejections=2"));
  fixture.db.close();
});

test("classifies review rejections as substantive or deferred by criterion citation", async () => {
  for (const [reviewMessage, expectation] of [
    ["Rejected: criterion A1 unmet — lobby denies the second player.", "task.rejection_recorded"],
    ["I would prefer different naming conventions here.", "task.deferred_finding"],
  ] as const) {
    const fixture = createManagerFixture(`review classification ${expectation}`);
    let workerDelegationRequestId = "";
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
              message: reviewMessage,
              occurredAt: "2026-07-13T03:00:04.000Z",
              metadata: {
                reviewMergeApplyOutcome: { status: "rejected", safeSummary: reviewMessage },
              },
            },
          ]);
        }
        if (supervisorStarted) {
          return createHandle(input.sessionId, []);
        }
        supervisorStarted = true;
        const childRun = fixture.runRepo.create({
          goalId: input.goalId,
          provider: "codex-local",
          model: "gpt-5-codex",
        });
        const child = fixture.agentSessionRepo.createSession({
          goalId: input.goalId,
          runId: childRun.id,
          providerId: "codex-local",
          modelLabel: "gpt-5-codex",
          lifecycleState: "completed",
          capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: false },
          parent: { sessionId: input.sessionId },
        });
        const request = fixture.agentSessionRepo.createDelegationRequest({
          parentSessionId: input.sessionId,
          role: "worker",
          promptSummary: "Implement lobby join.",
          taskId: "task-1",
          acceptance: [{ id: "A1", text: "Second player can join the lobby." }],
        });
        fixture.agentSessionRepo.acceptDelegationRequest(request.id);
        fixture.agentSessionRepo.startDelegationRequest(request.id, child.id);
        workerDelegationRequestId = fixture.agentSessionRepo.completeDelegationRequest(request.id, {
          kind: "success",
          safeSummary: "Worker produced a patch.",
        }).id;
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Announcing task.",
            occurredAt: "2026-07-13T03:00:00.000Z",
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
            message: "Requesting review.",
            occurredAt: "2026-07-13T03:00:01.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "review_merge",
                prompt: "Review and merge worker output.",
                workerDelegationRequestId,
              },
            },
          },
        ]);
      },
    };
    const manager = createAgentSessionManager({ ...fixture, supervisorCwd: "C:\\supervisor" });

    await manager.startManagedSession({
      goalId: fixture.goal.id,
      providerId: "codex-local",
      modelLabel: "gpt-5-codex",
      adapter,
    });
    await waitFor(() =>
      fixture.eventRepo.listForGoal(fixture.goal.id).some((event) => event.data.runtimeEventType === expectation),
    );

    const recorded = fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .find((event) => event.data.runtimeEventType === expectation);
    assert.equal(recorded?.data.taskId, "task-1");
    if (expectation === "task.rejection_recorded") {
      assert.deepEqual(recorded?.data.citedCriteria, ["A1"]);
    } else {
      assert.match(String(recorded?.data.finding), /naming conventions/);
    }
    await waitFor(() =>
      fixture.eventRepo
        .listForGoal(fixture.goal.id)
        .some((event) => event.data.runtimeEventType === "delegation.continuation_started"),
    );
    fixture.db.close();
  }
});

test("dispatches children on role-resolved adapters and records the resolved agent", async () => {
  const fixture = createManagerFixture("role assignment dispatch");
  let resolverCalls = 0;
  const childStarts: Array<{ provider: string; model: string | null }> = [];
  let supervisorStarted = false;
  const supervisorAdapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (supervisorStarted || input.parent?.sessionId) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(input.sessionId, [
        delegationRequestEvent(input.sessionId, input.goalId, input.runId),
        delegationRequestEvent(input.sessionId, input.goalId, input.runId),
      ]);
    },
  };
  const workerAdapter: AgentRuntimeAdapter = {
    providerId: "claude-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: false };
    },
    async startSession(input) {
      childStarts.push({ provider: input.providerId, model: input.modelLabel ?? null });
      return createHandle(input.sessionId, [
        {
          type: "session.completed",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Worker finished.",
          occurredAt: "2026-07-13T05:00:02.000Z",
        },
      ]);
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    roleAdapterResolver: (role) => {
      resolverCalls += 1;
      return role === "worker"
        ? { adapter: workerAdapter, providerId: "claude-local", modelLabel: "claude-sonnet-4" }
        : null;
    },
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: supervisorAdapter,
    prompt: "Delegate twice.",
  });
  await waitFor(() => childStarts.length === 2);
  await waitFor(
    () =>
      fixture.eventRepo
        .listForGoal(fixture.goal.id)
        .filter((event) => event.data.continuationMode === "fresh").length === 2,
  );

  assert.deepEqual(childStarts, [
    { provider: "claude-local", model: "claude-sonnet-4" },
    { provider: "claude-local", model: "claude-sonnet-4" },
  ]);
  const started = fixture.eventRepo
    .listForGoal(fixture.goal.id)
    .filter((event) => event.data.runtimeEventType === "delegation.started");
  assert.equal(started.length, 2);
  assert.equal(started[0]?.data.childProvider, "claude-local");
  assert.equal(started[0]?.data.childModel, "claude-sonnet-4");
  const sessions = fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id);
  const childSessions = sessions.filter((session) => session.parent?.sessionId);
  assert.equal(childSessions.length, 2);
  assert.equal(childSessions[0]?.providerId, "claude-local");
  assert.equal(fixture.runRepo.getById(childSessions[0]!.runId)?.provider, "claude-local");
  // Resolution is cached per goal+role across both delegations.
  assert.equal(resolverCalls, 1);
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

test("feeds control rejection reasons into the next supervisor continuation", async () => {
  const fixture = createManagerFixture("rejected control block");
  const starts: string[] = [];
  let supervisorTurn = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      starts.push(input.prompt);
      supervisorTurn += 1;
      if (supervisorTurn === 1) {
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Trying to complete without a summary.",
            occurredAt: "2026-07-06T00:00:01.000Z",
            metadata: {
              delegationControlEvent: { type: "managed_delegation.complete" },
            },
          },
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Turn ended.",
            occurredAt: "2026-07-06T00:00:02.000Z",
          },
        ]);
      }
      return createHandle(input.sessionId, [
        {
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Correcting completion.",
          occurredAt: "2026-07-06T00:00:03.000Z",
          metadata: {
            delegationControlEvent: {
              type: "managed_delegation.complete",
              summary: "Corrected completion.",
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

  assert.equal(starts.length, 2);
  assert.ok(starts[1]?.includes("Completion summary must be a non-empty string."));
  assert.ok(
    fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .some((event) => event.data.continuationReason === "control_rejected"),
  );
  fixture.db.close();
});

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

test("rejects a change plan that violates the plan budget without registering changes", async () => {
  const fixture = createManagerFixture("undersized change plan goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = adapterWithEvents([
    changePlanEvent([{ id: "only-change", title: "Only change", rationale: "Too small to plan." }]),
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
  const rejection = events.find((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.ok(rejection, "expected the plan to be rejected");
  assert.match(String(rejection.data.safeReason), /between 2 and 8/i);
  assert.ok(!events.some((event) => event.data.runtimeEventType === "supervisor.change_plan"));
  assert.ok(!events.some((event) => event.data.runtimeEventType === "change.activated"));
  assert.deepEqual(openSpec.scaffolded, []);

  fixture.db.close();
});

test("rejects a second change plan for the same goal", async () => {
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
  assert.match(String(rejection.data.safeReason), /plan already exists/i);
  assert.deepEqual(
    openSpec.scaffolded.map((call) => call.changeId),
    ["change-one", "change-two"],
  );

  fixture.db.close();
});

test("tags task lists and delegations with the active change and persists changeId on delegation rows", async () => {
  const fixture = createManagerFixture("change-tagged work goal");
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
      message: "Announcing tasks.",
      occurredAt: "2026-07-13T00:00:02.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.task_list",
          tasks: [
            {
              id: "task-1",
              title: "Implement the first slice",
              acceptance: [{ id: "A1", text: "The first slice works." }],
            },
          ],
        },
      },
    },
    {
      // While the change is specifying, its spec task is the delegable work;
      // the delegation must inherit the active changeId onto its row.
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Delegating the spec task.",
      occurredAt: "2026-07-13T00:00:03.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.request",
          role: "worker",
          taskId: "spec:change-one",
          prompt: "Author the change-one specs.",
          summary: "Author the change-one specs.",
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
  const taskListEvent = events.find((event) => event.data.runtimeEventType === "supervisor.task_list");
  assert.ok(taskListEvent, "expected a durable task list event");
  assert.equal(taskListEvent.data.changeId, "change-one");
  const request = fixture.agentSessionRepo
    .listDelegationRequests(result.session.id)
    .find((row) => row.taskId === "spec:change-one");
  assert.ok(request, "expected the spec delegation to dispatch");
  assert.equal(request.changeId, "change-one");

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

test("rejects task lists and delegations referencing a change that is not active", async () => {
  const fixture = createManagerFixture("out-of-order change goal");
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
      message: "Announcing tasks for the wrong change.",
      occurredAt: "2026-07-13T00:00:02.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.task_list",
          changeId: "change-two",
          tasks: [
            {
              id: "task-late",
              title: "Work on the later change",
              acceptance: [{ id: "A1", text: "The later slice works." }],
            },
          ],
        },
      },
    },
    {
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Delegating against the wrong change.",
      occurredAt: "2026-07-13T00:00:03.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.request",
          role: "worker",
          taskId: "spec:change-two",
          changeId: "change-two",
          prompt: "Author the later change specs.",
          summary: "Author the later change specs.",
        },
      },
    },
    {
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Delegating the later spec task without naming its change.",
      occurredAt: "2026-07-13T00:00:04.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.request",
          role: "worker",
          taskId: "spec:change-two",
          prompt: "Author the later change specs.",
          summary: "Author the later change specs.",
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
  const rejections = events.filter((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.equal(rejections.length, 3);
  for (const rejection of rejections) {
    assert.match(String(rejection.data.safeReason), /change-two is not active/i);
    assert.match(String(rejection.data.safeReason), /change-one/);
  }
  assert.ok(!events.some((event) => event.data.runtimeEventType === "supervisor.task_list"));
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

test("does not double-count a backend validation rejection when the supervisor re-delegates citing criteria", async () => {
  const fixture = createManagerFixture("spec retry goal");
  const openSpec = recordingOpenSpecService("cli", {
    validateFailures: [["tasks.md contains no tasks"]],
  });
  const resumeMessages: string[] = [];
  let supervisorStarted = false;
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
                prompt: "Author the OpenSpec artifacts.",
                summary: "Author change-one specs.",
              },
            },
          } satisfies AgentRuntimeEvent;
          await parentReleased;
          // The corrective re-delegation cites the failing criteria, as the
          // rejection prompt teaches. It must not burn a second rejection.
          yield {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Retrying spec authoring.",
            occurredAt: "2026-07-13T00:00:05.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "spec:change-one",
                prompt: "S1 and S3 failed: tasks.md had no tasks. Author every artifact this time.",
                summary: "Retry change-one specs fixing S1/S3.",
              },
            },
          } satisfies AgentRuntimeEvent;
        },
        async send(message) {
          resumeMessages.push(message.message ?? "");
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

  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(
    () =>
      fixture.agentSessionRepo
        .listDelegationRequests(result.session.id)
        .filter((request) => request.taskId === "spec:change-one").length === 2,
  );

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejections = events.filter((event) => event.data.runtimeEventType === "task.rejection_recorded");
  assert.equal(rejections.length, 1, "only the backend validation rejection should be recorded");
  assert.ok(!events.some((event) => event.data.runtimeEventType === "delegation.rejected"));
  const requests = fixture.agentSessionRepo
    .listDelegationRequests(result.session.id)
    .filter((request) => request.taskId === "spec:change-one");
  assert.equal(requests.length, 2, "the corrective re-delegation must dispatch");
  // The continuation observation carries the concrete failing checks so the
  // corrective re-delegation can tell the next worker what to fix.
  assert.ok(
    resumeMessages.some((message) => message.includes("tasks.md contains no tasks")),
    "continuation must carry the validation failure details",
  );

  fixture.db.close();
});

test("blocks the change and goal when spec authoring exhausts its retry budget", async () => {
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
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "blocked");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const blocked = events.find((event) => event.data.runtimeEventType === "change.blocked");
  assert.ok(blocked, "expected a durable change.blocked event");
  assert.equal(blocked.data.changeId, "change-one");
  assert.ok(events.some((event) => event.type === "goal.blocked"));
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "blocked");

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
      .some((event) => event.data.runtimeEventType === "change.spec_approved"),
  );

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const approved = events.find((event) => event.data.runtimeEventType === "change.spec_approved");
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
  // Approval only lands after the merged review outcome.
  const mergedIndex = events.findIndex((event) => event.data.runtimeEventType === "review_merge.apply_outcome");
  const approvedIndex = events.findIndex((event) => event.data.runtimeEventType === "change.spec_approved");
  assert.ok(mergedIndex >= 0 && approvedIndex > mergedIndex);

  fixture.db.close();
});

test("review merges work across fresh supervisor continuations using the id carried in the observation", async () => {
  const fixture = createManagerFixture("cross-session review merge goal");
  let supervisorTurn = 0;
  let childCount = 0;
  const continuationPrompts: string[] = [];
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
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
              message: "Worker changed files.",
              occurredAt: "2026-07-13T00:00:02.000Z",
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
            occurredAt: "2026-07-13T00:00:04.000Z",
            metadata: {
              reviewMergeApplyOutcome: { status: "merged", diffSummary: "1 file", safeSummary: "Merged." },
            },
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
            message: "Delegating the task.",
            occurredAt: "2026-07-13T00:00:01.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "worker",
                taskId: "task-1",
                acceptance: [{ id: "A1", text: "The file exists." }],
                prompt: "Create the file.",
                summary: "Create the file.",
              },
            },
          },
        ]);
      }
      if (supervisorTurn === 2) {
        continuationPrompts.push(input.prompt);
        // The fresh continuation only knows the worker delegation id if the
        // observation carried it — parse it from the prompt like a real
        // supervisor would.
        const workerDelegationRequestId =
          input.prompt.match(/workerDelegationRequestId: ([0-9a-f-]+)/i)?.[1] ?? "not-in-prompt";
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Requesting review merge from the continuation.",
            occurredAt: "2026-07-13T00:00:03.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "review_merge",
                workerDelegationRequestId,
                prompt: "Review and merge the worker changes.",
                summary: "Review worker changes.",
              },
            },
          },
        ]);
      }
      return createHandle(input.sessionId, []);
    },
  };
  const manager = createAgentSessionManager(fixture);

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });
  await waitFor(() =>
    fixture.eventRepo
      .listForGoal(fixture.goal.id)
      .some((event) => event.data.runtimeEventType === "review_merge.apply_outcome"),
  );

  assert.equal(continuationPrompts.length, 1);
  assert.match(continuationPrompts[0]!, /workerDelegationRequestId: [0-9a-f-]+/i);
  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(
    !events.some(
      (event) =>
        event.data.runtimeEventType === "delegation.rejected" &&
        /worker result/i.test(String(event.data.safeReason)),
    ),
    "the cross-session review merge must not be rejected",
  );
  const merged = events.find((event) => event.data.runtimeEventType === "review_merge.apply_outcome");
  assert.ok(merged);
  assert.equal(merged.data.reviewMergeOutcome, "merged");

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
              type: "managed_delegation.request",
              role: "review_merge",
              workerDelegationRequestId: latestWorkerRequestId(input.sessionId),
              prompt: "Merge change-two specs.",
              summary: "Merge change-two specs.",
            },
            "2026-07-13T00:00:11.000Z",
          );
          await gates[5]!.promise;
          yield controlEvent(
            input,
            { type: "managed_delegation.complete", summary: "Both changes delivered." },
            "2026-07-13T00:00:12.000Z",
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
    "change.spec_approved",
    "change.archive_blocked",
    "change.archived",
    "delegation.rejected",
    "supervisor.completed",
  ]);
  const lifecycle = events
    .filter((event) => changeLifecycleTypes.has(String(event.data.runtimeEventType)))
    .map((event) => [event.data.runtimeEventType, event.data.changeId ?? null]);
  assert.deepEqual(lifecycle, [
    ["supervisor.change_plan", null],
    ["change.activated", "change-one"],
    ["change.spec_approved", "change-one"],
    ["change.archive_blocked", "change-one"],
    ["change.archived", "change-one"],
    ["change.activated", "change-two"],
    ["delegation.rejected", null],
    ["change.spec_approved", "change-two"],
    ["change.archived", "change-two"],
    ["supervisor.completed", null],
    ["supervisor.completed", null],
  ]);

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

function createHandle(sessionId: string, events: AgentRuntimeEvent[]): AgentSessionHandle {
  return {
    sessionId,
    capabilities: {
      eventStreaming: true,
      approval: true,
      cancellation: true,
      resume: false,
      childSessions: false,
    },
    async *events() {
      for (const event of events) yield event;
    },
    async send() {},
    async approve() {},
    async reject() {},
    async cancel() {},
  };
}

function adapterWithEvents(events: AgentRuntimeEvent[]): AgentRuntimeAdapter {
  let supervisorStarted = false;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return {
        eventStreaming: true,
        approval: false,
        cancellation: true,
        resume: false,
        childSessions: true,
      };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, []);
      }
      // Continuation sessions get an inert handle so scripted supervisor
      // events run exactly once.
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      return createHandle(
        input.sessionId,
        events.map((event) => ({
          ...event,
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
        })),
      );
    },
  };
}

function terminalEvent(goalId: string): AgentRuntimeEvent {
  return {
    type: "session.completed",
    sessionId: "session-placeholder",
    goalId,
    runId: "run-placeholder",
    message: "Supervisor stopped after validation.",
    occurredAt: "2026-07-03T00:00:03.000Z",
  };
}

function delegationRequestEvent(sessionId: string, goalId: string, runId: string): AgentRuntimeEvent {
  return {
    type: "progress",
    sessionId,
    goalId,
    runId,
    message: "Requesting worker.",
    occurredAt: "2026-07-03T00:00:01.000Z",
    metadata: {
      delegationControlEvent: {
        type: "managed_delegation.request",
        role: "worker",
        prompt: "Run focused tests.",
        summary: "Run focused tests.",
      },
    },
  };
}

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
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    worktreeAttestor: () => ["src/change.ts"],
    managedDeliveryService: {
      deliver() {
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
    managedDeliveryService: {
      deliver() {
        return {
          status: "conflict", safeSummary: "Candidate conflicted; checkpoint restored.", checkpointHead: "base",
          checkpointStatus: "clean", candidateCommitSha: "candidate-1", commitSha: null,
          validationCommand: null, validationExitCode: null, validationSummary: null,
          rollbackSummary: "restored", candidateFiles: ["src/change.ts"], conflictFiles: ["src/change.ts"],
          conflictSummary: "CONFLICT src/change.ts",
        };
      },
      deliverCandidate() {
        return {
          status: "committed", safeSummary: "Resolved candidate committed.", checkpointHead: "base",
          checkpointStatus: "clean", candidateCommitSha: "candidate-2", commitSha: "delivered-2",
          validationCommand: "npm test", validationExitCode: 0, validationSummary: "passed", rollbackSummary: null,
        };
      },
    },
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

function createManagerFixture(title: string) {
  const db = openDatabase({
    path: join(mkdtempSync(join(tmpdir(), "auto-agent-session-section4-")), "runtime.sqlite"),
  });
  const goalRepo = createGoalRepository(db);
  const runRepo = createRunRepository(db);
  const eventRepo = createEventRepository(db);
  const agentSessionRepo = createAgentSessionRepository(db);
  const goal = goalRepo.create({ title, description: "Exercise section 4 delegation behavior." });
  goalRepo.updateStatus(goal.id, "running", { startedAt: "2026-07-03T00:00:00.000Z" });
  return {
    db,
    goal,
    goalRepo,
    runRepo,
    eventRepo,
    agentSessionRepo,
    worktreeService: memoryWorktreeService(),
    reviewMergeWorkspaceService: cleanReviewMergeWorkspaceService(),
    reviewMergeVerificationService: passingReviewMergeVerificationService(),
  };
}

function memoryWorktreeService() {
  return {
    async createChildWorktree(input: { childSessionId: string }) {
      return { path: `C:\\worktrees\\${input.childSessionId}`, label: `child-${input.childSessionId}` };
    },
  };
}

function cleanReviewMergeWorkspaceService() {
  return {
    async prepareReviewMerge() {
      return { ok: true as const, checkpoint: { head: "checkpoint-head", statusSummary: "clean" } };
    },
  };
}

function passingReviewMergeVerificationService() {
  return {
    verifyMerged() {
      return {
        outcome: "merged" as const,
        fixedTest: {
          command: "npm run typecheck",
          exitCode: 0,
          outputSummary: "typecheck passed",
        },
        revertEvidence: null,
        safeSummary: "Fixed review-merge test command passed.",
      };
    },
  };
}

function adapterWithSeededReviewMergeRequest(
  fixture: ReturnType<typeof createManagerFixture>,
  options: {
    onReviewMergeStart?: () => void;
    reviewMergeOutcome?: {
      status: "merged" | "rejected" | "conflict";
      diffSummary?: string | null;
      safeSummary?: string | null;
    };
  } = {},
): AgentRuntimeAdapter {
  let workerDelegationRequestId = "";
  let supervisorStarted = false;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (!input.parent?.sessionId && supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      if (!input.parent?.sessionId) {
        supervisorStarted = true;
        const childRun = fixture.runRepo.create({
          goalId: input.goalId,
          provider: "codex-local",
          model: "gpt-5-codex",
        });
        const child = fixture.agentSessionRepo.createSession({
          goalId: input.goalId,
          runId: childRun.id,
          providerId: "codex-local",
          modelLabel: "gpt-5-codex",
          lifecycleState: "completed",
          capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: false },
          parent: { sessionId: input.sessionId },
        });
        const request = fixture.agentSessionRepo.createDelegationRequest({
          parentSessionId: input.sessionId,
          role: "worker",
          promptSummary: "Implement focused change.",
        });
        fixture.agentSessionRepo.acceptDelegationRequest(request.id);
        fixture.agentSessionRepo.startDelegationRequest(request.id, child.id);
        workerDelegationRequestId = fixture.agentSessionRepo.completeDelegationRequest(request.id, {
          kind: "success",
          safeSummary: "Worker produced a patch.",
        }).id;
        return createHandle(input.sessionId, [
          {
            type: "progress",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: "Requesting review merge.",
            occurredAt: "2026-07-03T00:00:03.000Z",
            metadata: {
              delegationControlEvent: {
                type: "managed_delegation.request",
                role: "review_merge",
                prompt: "Review and merge worker output.",
                summary: "Review worker output.",
                workerDelegationRequestId,
              },
            },
          },
        ]);
      }
      options.onReviewMergeStart?.();
      return createHandle(input.sessionId, [
        {
          type: "session.completed",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Review merge completed.",
          occurredAt: "2026-07-03T00:00:04.000Z",
          metadata: {
            reviewMergeApplyOutcome: options.reviewMergeOutcome ?? {
              status: "merged",
              diffSummary: "1 file changed.",
              safeSummary: "Applied.",
            },
          },
        },
      ]);
    },
  };
}

function changePlanEvent(
  changes: Array<{ id: string; title: string; rationale: string; dependsOn?: string[] }>,
): AgentRuntimeEvent {
  return {
    type: "progress",
    sessionId: "session-placeholder",
    goalId: "goal-placeholder",
    runId: "run-placeholder",
    message: "Announcing change plan.",
    occurredAt: "2026-07-13T00:00:01.000Z",
    metadata: {
      delegationControlEvent: {
        type: "managed_change.plan",
        changes,
      },
    },
  };
}

function recordingOpenSpecService(
  mode: "cli" | "degraded",
  options: { validateFailures?: string[][] } = {},
) {
  const scaffolded: Array<{ changeId: string; cwd: string }> = [];
  const validated: Array<{ changeId: string; cwd: string }> = [];
  const archived: Array<{ changeId: string; cwd: string; date: string }> = [];
  const pendingFailures = [...(options.validateFailures ?? [])];
  const service: OpenSpecWorkspaceService = {
    mode: () => mode,
    scaffoldChange(input) {
      scaffolded.push({ changeId: input.change.id, cwd: input.cwd });
      return { ok: true, committed: true };
    },
    validateChange(input) {
      validated.push({ changeId: input.changeId, cwd: input.cwd });
      const failures = pendingFailures.shift() ?? [];
      return { ok: failures.length === 0, failures };
    },
    archiveChange(input) {
      archived.push({ changeId: input.changeId, cwd: input.cwd, date: input.date });
      return { ok: true };
    },
  };
  return { scaffolded, validated, archived, service };
}

function fixedClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}
