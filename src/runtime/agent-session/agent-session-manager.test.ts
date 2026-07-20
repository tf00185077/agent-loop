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
  adapterWithSeededReviewMergeRequest,
  changePlanEvent,
  createHandle,
  createManagerFixture,
  delegationRequestEvent,
  fixedClock,
  memoryWorktreeService,
  recordingOpenSpecService,
  runScript,
  scriptedEpochAdapter,
  terminalEvent,
  waitFor,
} from "./agent-session-test-harness.js";

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
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.equal(starts.length, 3);
  assert.ok(/continue or complete/i.test(starts[1] ?? ""));
  assert.equal(
    events.filter((event) => event.data.continuationReason === "completionless_exit").length,
    2,
  );
  const blocked = events.find((event) => event.type === "goal.input_requested");
  assert.equal(blocked?.data.runtimeEventType, "supervisor.continuations_exhausted");
  assert.equal(blocked?.data.maxSupervisorContinuations, 2);
  assert.match(String(blocked?.data.reason), /without a completion signal/i);
  assert.equal(blocked?.data.completionRequestEvaluated, false);
  assert.equal(fixture.goalInputRequestRepo.getPending(fixture.goal.id)?.reasonCode, "continuation_exhausted");
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
  await waitFor(() => fixture.goalRepo.getById(fixture.goal.id)?.status === "waiting_user");

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

test("cancelling a supervisor session cancels its in-flight child sessions first", async () => {
  const fixture = createManagerFixture("cascade cancel goal");
  const controls: string[] = [];
  let supervisorSessionId = "";
  let childStarted = false;
  let releaseSupervisor!: () => void;
  const supervisorGate = new Promise<void>((resolve) => { releaseSupervisor = resolve; });
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        childStarted = true;
        return {
          sessionId: input.sessionId,
          capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: false },
          async *events() {
            await childGate;
            yield {
              type: "session.cancelled", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
              message: "Child cancelled", occurredAt: "2026-07-17T00:00:03.000Z",
            } satisfies AgentRuntimeEvent;
          },
          async send() {},
          async approve() {},
          async reject() {},
          async cancel() {
            controls.push("child-cancelled");
            releaseChild();
          },
        };
      }
      supervisorSessionId = input.sessionId;
      return {
        sessionId: input.sessionId,
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true },
        async *events() {
          yield {
            type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Delegating.", occurredAt: "2026-07-17T00:00:01.000Z",
            metadata: { delegationControlEvent: {
              type: "managed_delegation.request", role: "worker",
              prompt: "Do the work.", summary: "Do the work.",
            } },
          } satisfies AgentRuntimeEvent;
          await supervisorGate;
          yield {
            type: "session.cancelled", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Supervisor cancelled", occurredAt: "2026-07-17T00:00:04.000Z",
          } satisfies AgentRuntimeEvent;
        },
        async send() {},
        async approve() {},
        async reject() {},
        async cancel() {
          controls.push("supervisor-cancelled");
          releaseSupervisor();
        },
      };
    },
  };
  const manager = createAgentSessionManager({ ...fixture, supervisorCwd: "C:\\goal-workspace" });

  const running = manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => childStarted);

  assert.equal(await manager.cancel(supervisorSessionId, "operator stop"), true);
  await running;

  assert.deepEqual(
    controls,
    ["child-cancelled", "supervisor-cancelled"],
    "the in-flight child must be cancelled before (and along with) its supervisor",
  );
  fixture.db.close();
});

test("review-merge with an unresolvable worker id is rejected naming the latest completed attempt", async () => {
  const fixture = createManagerFixture("teaching review-merge rejection");
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
        // The live-observed mistake: passing the task id where the delegation
        // request id belongs.
        yield tools.controlEvent(
          {
            type: "managed_delegation.request",
            role: "review_merge",
            workerDelegationRequestId: "spec:change-one",
            prompt: "Merge change-one specs.",
            summary: "Merge change-one specs.",
          },
          "2026-07-13T00:00:03.000Z",
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
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id).some((event) =>
    event.data.runtimeEventType === "delegation.rejected" &&
    /worker result/i.test(String(event.data.safeReason))));

  const workerId = fixture.agentSessionRepo.listSessionsForGoal(fixture.goal.id)
    .flatMap((session) => fixture.agentSessionRepo.listDelegationRequests(session.id))
    .find((request) => request.role === "worker" && request.resultSummary)!.id;
  const rejection = fixture.eventRepo.listForGoal(fixture.goal.id).find((event) =>
    event.data.runtimeEventType === "delegation.rejected" &&
    /worker result/i.test(String(event.data.safeReason)))!;
  const reason = String(rejection.data.safeReason);
  assert.ok(reason.includes(workerId), "the rejection must name the latest completed worker attempt id");
  assert.match(reason, /task spec:change-one/, "the rejection must name the attempt's task for orientation");
  assert.match(reason, /not the task id/i, "the rejection must teach the id-vs-task distinction");
  fixture.db.close();
});
