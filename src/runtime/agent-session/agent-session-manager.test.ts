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
  // The goal is reconciled to a resumable `interrupted` state, not force-failed.
  const recoveryEvent = eventRepo
    .listForGoal(goal.id)
    .find((event) => event.data.runtimeEventType === "recovery.reconciled" && event.data.sessionId === running.id);
  assert.ok(recoveryEvent);
  assert.match(recoveryEvent.message, /reconciled/i);
  assert.equal(runRepo.getById(run.id)?.status, "failed");
  assert.equal(goalRepo.getById(goal.id)?.status, "interrupted");
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
      async removeWorktree() {},
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
  assert.match(String(blocked?.data.reason), /without a completion signal/i);
  assert.equal(blocked?.data.completionRequestEvaluated, false);
  fixture.db.close();
});

test("continuation accounting preserves configured maximum, reason reset, increments, and exact exhaustion text", async () => {
  const fixture = createManagerFixture("continuation compatibility");
  let turn = 0;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      turn += 1;
      if (turn === 1) {
        return createHandle(input.sessionId, [
          {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Malformed completion", occurredAt: "2026-07-17T00:00:01.000Z",
            metadata: { delegationControlEvent: { type: "managed_delegation.complete" } },
          },
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Rejected turn ended", occurredAt: "2026-07-17T00:00:02.000Z" },
        ]);
      }
      return createHandle(input.sessionId, [{
        type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Completionless turn ended", occurredAt: `2026-07-17T00:00:0${turn + 1}.000Z`,
      }]);
    },
  };
  const manager = createAgentSessionManager({ ...fixture, maxSupervisorContinuations: 2 });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "blocked");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.equal(turn, 3, "one initial turn plus exactly two continuations");
  assert.deepEqual(events.filter((event) => event.data.runtimeEventType === "delegation.continuation_started")
    .map((event) => event.data.continuationReason), ["control_rejected", "completionless_exit"]);
  const exhausted = events.find((event) => event.data.runtimeEventType === "supervisor.continuations_exhausted")!;
  assert.equal(exhausted.data.maxSupervisorContinuations, 2);
  assert.equal(exhausted.data.completionRequestEvaluated, false);
  assert.equal(exhausted.message, "Supervisor reached 2 continuations without a completion signal");
  assert.equal(exhausted.data.reason, exhausted.message);
  fixture.db.close();
});

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
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "blocked");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const rejected = events.filter((event) => event.data.runtimeEventType === "delegation.rejected");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((event) => Array.isArray(event.data.completionGaps)));
  const blocked = events.find((event) => event.data.runtimeEventType === "supervisor.continuations_exhausted");
  assert.match(String(blocked?.data.reason), /without reaching successful completion/i);
  assert.equal(blocked?.data.completionRequestEvaluated, true);
  assert.deepEqual(blocked?.data.completionGaps, rejected.at(-1)?.data.completionGaps);
  assert.ok((blocked?.data.completionGaps as Array<{ type: string }>).some((gap) => gap.type === "criterion_not_passed"));
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
  const parentAcceptance = [
    ...acceptance,
    { id: "A2", text: "A third player is rejected." },
  ];
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
                tasks: [{ id: "task-1", title: "Lobby join", acceptance: parentAcceptance }],
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

test("durably splits an exhausted parent when the supervisor directly registers narrower children", async () => {
  const fixture = createManagerFixture("direct durable narrowing");
  const managedTaskRepo = createManagedTaskRepository(fixture.db, {
    now: () => "2026-07-17T00:00:00.000Z",
  });
  managedTaskRepo.registerTasks({
    goalId: fixture.goal.id,
    tasks: [{
      id: "parent",
      title: "Large task",
      acceptance: [{ id: "A1", text: "First behavior" }, { id: "A2", text: "Second behavior" }],
    }],
  });
  fixture.db.prepare(`
    UPDATE managed_tasks
    SET status = 'rejected', attempt_count = 2, substantive_rejection_count = 2,
      last_cited_criteria = '["A1"]'
    WHERE goal_id = ? AND logical_task_id = 'parent'
  `).run(fixture.goal.id);
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([{
      type: "progress",
      sessionId: "session-placeholder",
      goalId: fixture.goal.id,
      runId: "run-placeholder",
      message: "Register the narrowed child directly.",
      occurredAt: "2026-07-17T00:00:01.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_delegation.task_list",
          tasks: [{
            id: "child",
            title: "First behavior only",
            parentTaskId: "parent",
            acceptance: [{ id: "A1", text: "First behavior" }],
          }],
        },
      },
    }]),
  });

  assert.equal(managedTaskRepo.getTask(fixture.goal.id, "parent")?.status, "split");
  assert.equal(managedTaskRepo.getTask(fixture.goal.id, "child")?.parentTaskId, "parent");
  const lineageEvents = fixture.eventRepo.listForGoal(fixture.goal.id)
    .filter((event) => event.data.runtimeEventType === "managed_task.lineage_split");
  assert.equal(lineageEvents.length, 1);
  assert.deepEqual(lineageEvents[0]?.data.taskIds, ["child"]);
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

test("registers the same synthetic task ids independently for two managed goals", async () => {
  const fixture = createManagerFixture("first same-name plan");
  const secondGoal = fixture.goalRepo.create({ title: "second same-name plan", description: "Reuse change ids." });
  fixture.goalRepo.updateStatus(secondGoal.id, "running", { startedAt: "2026-07-13T00:00:00.000Z" });
  const managedTaskRepo = createManagedTaskRepository(fixture.db);
  const openSpec = recordingOpenSpecService("cli");
  const manager = createAgentSessionManager({
    ...fixture,
    database: fixture.db,
    managedTaskRepo,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });
  const plan = [
    { id: "feature-a", title: "Feature A", rationale: "First slice." },
    { id: "feature-b", title: "Feature B", rationale: "Second slice." },
  ];

  await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([changePlanEvent(plan)]),
  });
  await manager.startManagedSession({
    goalId: secondGoal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter: adapterWithEvents([changePlanEvent(plan)]),
  });

  assert.deepEqual(managedTaskRepo.listForGoal(fixture.goal.id).map((task) => task.id), [
    "spec:feature-a", "spec:feature-b",
  ]);
  assert.deepEqual(managedTaskRepo.listForGoal(secondGoal.id).map((task) => task.id), [
    "spec:feature-a", "spec:feature-b",
  ]);
  const internalIds = fixture.db.prepare(`
    SELECT id FROM managed_tasks WHERE logical_task_id = 'spec:feature-a' ORDER BY goal_id
  `).all() as Array<{ id: string }>;
  assert.equal(internalIds.length, 2);
  assert.notEqual(internalIds[0]?.id, internalIds[1]?.id);
  for (const goalId of [fixture.goal.id, secondGoal.id]) {
    const planEvent = fixture.eventRepo.listForGoal(goalId)
      .find((event) => event.data.runtimeEventType === "supervisor.change_plan");
    assert.match(JSON.stringify(planEvent?.data.specTasks), /spec:feature-a/);
    assert.ok(!JSON.stringify(planEvent?.data.specTasks).includes(internalIds[0]!.id));
    assert.ok(!JSON.stringify(planEvent?.data.specTasks).includes(internalIds[1]!.id));
  }
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

interface EpochScriptTools {
  gates: Array<{ promise: Promise<void> }>;
  controlEvent: (block: Record<string, unknown>, at: string) => AgentRuntimeEvent;
  latestWorkerRequestId: () => string;
}

/**
 * Resume-capable scripted supervisor whose children alternate worker success
 * and merged review outcomes; each child outcome releases the next gate.
 * Mirrors the change-lifecycle fixture for multi-epoch flows.
 */
function scriptedEpochAdapter(
  fixture: ReturnType<typeof createManagerFixture>,
  gateCount: number,
  script: (
    input: { sessionId: string; goalId: string; runId: string },
    tools: EpochScriptTools,
  ) => AsyncGenerator<AgentRuntimeEvent>,
): AgentRuntimeAdapter {
  const gates = Array.from({ length: gateCount }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  let sendCount = 0;
  let supervisorStarted = false;
  let childCount = 0;
  return {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childCount += 1;
        const isWorker = childCount % 2 === 1;
        return createHandle(input.sessionId, [
          {
            type: "session.completed",
            sessionId: input.sessionId,
            goalId: input.goalId,
            runId: input.runId,
            message: isWorker ? "Worker finished." : "Review merge completed.",
            occurredAt: "2026-07-13T00:00:03.000Z",
            ...(isWorker
              ? {}
              : {
                  metadata: {
                    reviewMergeApplyOutcome: {
                      status: "merged" as const,
                      diffSummary: "changes applied",
                      safeSummary: "Merged.",
                    },
                  },
                }),
          },
        ]);
      }
      if (supervisorStarted) {
        return createHandle(input.sessionId, []);
      }
      supervisorStarted = true;
      const tools: EpochScriptTools = {
        gates,
        controlEvent: (block, at) => ({
          type: "progress",
          sessionId: input.sessionId,
          goalId: input.goalId,
          runId: input.runId,
          message: "Supervisor control block.",
          occurredAt: at,
          metadata: { delegationControlEvent: block },
        }),
        latestWorkerRequestId: () =>
          fixture.agentSessionRepo
            .listDelegationRequests(input.sessionId)
            .filter((request) => request.role === "worker" && request.resultSummary)
            .at(-1)?.id ?? "missing",
      };
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        events: () => script({ sessionId: input.sessionId, goalId: input.goalId, runId: input.runId }, tools),
        async send() {
          gates[sendCount++]?.release();
        },
      };
    },
  };
}

function* specFlow(
  tools: EpochScriptTools,
  changeId: string,
  firstGate: number,
  at: (offset: number) => string,
): Generator<AgentRuntimeEvent | Promise<void>> {
  yield tools.controlEvent(
    {
      type: "managed_delegation.request",
      role: "worker",
      taskId: `spec:${changeId}`,
      prompt: `Author ${changeId} specs.`,
      summary: `Author ${changeId} specs.`,
    },
    at(0),
  );
  yield tools.gates[firstGate]!.promise;
  // The Supervisor approval gate: review-merge for a spec attempt is rejected
  // until the validated attempt carries an approve decision.
  yield tools.controlEvent(
    {
      type: "managed_change.spec_review",
      changeId,
      workerDelegationRequestId: tools.latestWorkerRequestId(),
      decision: "approve",
      summary: `Spec for ${changeId} is semantically sufficient.`,
    },
    at(1),
  );
  yield tools.controlEvent(
    {
      type: "managed_delegation.request",
      role: "review_merge",
      workerDelegationRequestId: tools.latestWorkerRequestId(),
      prompt: `Merge ${changeId} specs.`,
      summary: `Merge ${changeId} specs.`,
    },
    at(1),
  );
  yield tools.gates[firstGate + 1]!.promise;
}

async function* runScript(
  steps: Generator<AgentRuntimeEvent | Promise<void>>,
): AsyncGenerator<AgentRuntimeEvent> {
  for (const step of steps) {
    if (step instanceof Promise) await step;
    else yield step;
  }
}

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
            remainingGaps: ["End-to-end verification is missing."],
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
  assert.deepEqual(reassessments[0]!.data.remainingGaps, ["End-to-end verification is missing."]);

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
            remainingGaps: ["The same gap remains."],
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
            remainingGaps: ["  The SAME   gap remains. "],
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
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "blocked");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const breaker = events.find(
    (event) => event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker",
  );
  assert.ok(breaker, "expected a durable circuit-breaker event");
  assert.equal(breaker.type, "goal.blocked");
  assert.match(String(breaker.data.safeReason), /same remaining gaps/i);
  assert.deepEqual(breaker.data.remainingGaps, ["The SAME   gap remains."]);
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
            remainingGaps: ["More work is needed."],
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
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "blocked");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const exhausted = events.find(
    (event) => event.data.runtimeEventType === "supervisor.epoch_budget_exhausted",
  );
  assert.ok(exhausted, "expected a durable epoch-budget event");
  assert.equal(exhausted.type, "goal.blocked");
  assert.match(String(exhausted.data.safeReason), /planning-epoch budget \(1\)/);

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
            remainingGaps: ["Everything."],
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
  assert.match(String(prematureRejection.data.safeReason), /archived first.*change-one/i);
  assert.equal(plannedFixture.goalRepo.getById(plannedFixture.goal.id)?.status, "running");
  plannedFixture.db.close();
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
    async removeWorktree() {},
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
  options: {
    validateFailures?: string[][];
    scaffoldResults?: Array<{ ok: boolean; committed: boolean; safeReason?: string }>;
  } = {},
) {
  const scaffolded: Array<{ changeId: string; cwd: string }> = [];
  const validated: Array<{ changeId: string; cwd: string }> = [];
  const archived: Array<{ changeId: string; cwd: string; date: string }> = [];
  const pendingFailures = [...(options.validateFailures ?? [])];
  const pendingScaffoldResults = [...(options.scaffoldResults ?? [])];
  const service: OpenSpecWorkspaceService = {
    mode: () => mode,
    scaffoldChange(input) {
      scaffolded.push({ changeId: input.change.id, cwd: input.cwd });
      return pendingScaffoldResults.shift() ?? { ok: true, committed: true };
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

test("contains control-path faults durably instead of killing the event pump", async () => {
  const fixture = createManagerFixture("event pump fault containment");
  let thrown = false;
  const eventRepo: typeof fixture.eventRepo = {
    ...fixture.eventRepo,
    create(input) {
      if (!thrown && input.data?.runtimeEventType === "task.result") {
        thrown = true;
        throw new Error("synthetic control-path fault under C:\\goal-workspace\\state");
      }
      return fixture.eventRepo.create(input);
    },
  };
  const adapter = adapterWithEvents([
    {
      type: "progress",
      sessionId: "s",
      goalId: "g",
      runId: "r",
      message: "Reporting task result.",
      occurredAt: "2026-07-17T00:00:01.000Z",
      metadata: {
        delegationControlEvent: {
          type: "managed_task.result",
          taskId: "task-1",
          criterionEvidence: [{ criterionId: "A1", evidence: "Verified." }],
        },
      },
    },
  ]);
  const manager = createAgentSessionManager({
    ...fixture,
    eventRepo,
    supervisorCwd: "C:\\goal-workspace",
  });

  // Must resolve: a control-path fault is contained, never rethrown into the caller.
  const result = await manager.startManagedSession({
    goalId: fixture.goal.id,
    providerId: "codex-local",
    modelLabel: "gpt-5-codex",
    adapter,
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  const failure = events.find((event) => event.data.runtimeEventType === "runtime.event_pump_failed");
  assert.ok(failure, "expected a durable runtime.event_pump_failed event");
  assert.equal(failure.type, "error");
  assert.match(String(failure.data.safeReason), /synthetic control-path fault/);
  assert.ok(
    !String(failure.data.safeReason).includes("C:\\goal-workspace"),
    "safe reason must not leak the raw workspace path",
  );
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "failed");
  assert.equal(fixture.runRepo.getById(result.session.runId)?.status, "failed");
  assert.equal(
    fixture.agentSessionRepo.getSession(result.session.id)?.lifecycleState,
    "failed",
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

function createSpecReviewWorktree(changeId: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "auto-agent-spec-review-"));
  const root = join(cwd, "openspec", "changes", changeId);
  mkdirSync(join(root, "specs", "capability"), { recursive: true });
  writeFileSync(join(root, "proposal.md"), "# Proposal\n\nBounded review packet content.\n");
  writeFileSync(join(root, "specs", "capability", "spec.md"), [
    "## ADDED Requirements", "", "### Requirement: Reviewable specs", "",
    "#### Scenario: Supervisor reviews", "- **WHEN** validation passes", "- **THEN** review is requested", "",
  ].join("\n"));
  writeFileSync(join(root, "tasks.md"), "- [ ] 1.1 Implement review\n  - Acceptance: focused tests pass.\n");
  return cwd;
}

function specWorkerDelegationEvent(
  input: { sessionId: string; goalId: string; runId: string },
  occurredAt: string,
): AgentRuntimeEvent {
  return {
    type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
    message: "Delegating spec authoring.", occurredAt,
    metadata: { delegationControlEvent: {
      type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
      prompt: "Author change-one specs.", summary: "Author change-one specs.",
    } },
  };
}

function specReviewControlEvent(
  input: { sessionId: string; goalId: string; runId: string },
  controlEvent: Record<string, unknown>,
  occurredAt: string,
): AgentRuntimeEvent {
  return {
    type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
    message: "Supervisor spec review.", occurredAt, metadata: { delegationControlEvent: controlEvent },
  };
}

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
