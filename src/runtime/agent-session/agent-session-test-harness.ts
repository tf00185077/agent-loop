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
import { openDatabase, type AppDatabase } from "../../persistence/database.js";
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

/* Shared fixtures for the agent-session manager test suite (split by theme). */

export interface EpochScriptTools {
  gates: Array<{ promise: Promise<void> }>;
  controlEvent: (block: Record<string, unknown>, at: string) => AgentRuntimeEvent;
  latestWorkerRequestId: () => string;
}

/**
 * Resume-capable scripted supervisor whose children alternate worker success
 * and merged review outcomes; each child outcome releases the next gate.
 * Mirrors the change-lifecycle fixture for multi-epoch flows.
 */

export function scriptedEpochAdapter(
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

export function* specFlow(
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

export async function* runScript(
  steps: Generator<AgentRuntimeEvent | Promise<void>>,
): AsyncGenerator<AgentRuntimeEvent> {
  for (const step of steps) {
    if (step instanceof Promise) await step;
    else yield step;
  }
}

export function createHandle(sessionId: string, events: AgentRuntimeEvent[]): AgentSessionHandle {
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

export function adapterWithEvents(events: AgentRuntimeEvent[]): AgentRuntimeAdapter {
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

export function terminalEvent(goalId: string): AgentRuntimeEvent {
  return {
    type: "session.completed",
    sessionId: "session-placeholder",
    goalId,
    runId: "run-placeholder",
    message: "Supervisor stopped after validation.",
    occurredAt: "2026-07-03T00:00:03.000Z",
  };
}

export function delegationRequestEvent(sessionId: string, goalId: string, runId: string): AgentRuntimeEvent {
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

export interface ManagerFixture {
  db: AppDatabase;
  goal: ReturnType<ReturnType<typeof createGoalRepository>["create"]>;
  goalRepo: ReturnType<typeof createGoalRepository>;
  runRepo: ReturnType<typeof createRunRepository>;
  eventRepo: ReturnType<typeof createEventRepository>;
  agentSessionRepo: ReturnType<typeof createAgentSessionRepository>;
  worktreeService: ReturnType<typeof memoryWorktreeService>;
  reviewMergeWorkspaceService: ReturnType<typeof cleanReviewMergeWorkspaceService>;
  reviewMergeVerificationService: ReturnType<typeof passingReviewMergeVerificationService>;
}

export function createManagerFixture(title: string): ManagerFixture {
  const db: AppDatabase = openDatabase({
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

export function memoryWorktreeService() {
  return {
    async createChildWorktree(input: { childSessionId: string }) {
      return { path: `C:\\worktrees\\${input.childSessionId}`, label: `child-${input.childSessionId}` };
    },
    async removeWorktree() {},
  };
}

export function cleanReviewMergeWorkspaceService() {
  return {
    async prepareReviewMerge() {
      return { ok: true as const, checkpoint: { head: "checkpoint-head", statusSummary: "clean" } };
    },
  };
}

export function passingReviewMergeVerificationService() {
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

export function adapterWithSeededReviewMergeRequest(
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

export function changePlanEvent(
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

export function recordingOpenSpecService(
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

export function fixedClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}

export function createSpecReviewWorktree(changeId: string): string {
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

export function specWorkerDelegationEvent(
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

export function specReviewControlEvent(
  input: { sessionId: string; goalId: string; runId: string },
  controlEvent: Record<string, unknown>,
  occurredAt: string,
): AgentRuntimeEvent {
  return {
    type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
    message: "Supervisor spec review.", occurredAt, metadata: { delegationControlEvent: controlEvent },
  };
}
