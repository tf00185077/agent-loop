import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntimeWorktreeMetadata } from "../../domain/index.js";
import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import {
  createAgentSessionRepository,
  createEventRepository,
  createRunRepository,
} from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createGitWorktreeService, type RemoveWorktreeInput, type WorktreeService } from "./worktree-service.js";

const CAPS = { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };

function seed(db: AppDatabase, terminal: boolean, worktree: AgentRuntimeWorktreeMetadata | null): string {
  const goal = createGoalRepository(db).create({ title: "G", description: "d" });
  const run = createRunRepository(db).create({ goalId: goal.id, provider: "mock", model: "m" });
  createAgentSessionRepository(db).createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "m",
    lifecycleState: terminal ? "failed" : "running", capabilities: CAPS, worktree,
  });
  if (terminal) createGoalRepository(db).updateStatus(goal.id, "failed", { completedAt: "2026-07-16T00:00:00.000Z" });
  return goal.id;
}

function manager(db: AppDatabase, worktreeService: WorktreeService) {
  return createAgentSessionManager({
    goalRepo: createGoalRepository(db),
    runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db),
    agentSessionRepo: createAgentSessionRepository(db),
    database: db,
    worktreeService,
    supervisorCwd: "C:\\supervisor",
  });
}

function eventsOfType(db: AppDatabase, type: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT data FROM events").all() as Array<{ data: string }>)
    .map((r) => JSON.parse(r.data) as Record<string, unknown>)
    .filter((d) => d.runtimeEventType === type);
}

test("reclaims a terminal-goal worktree and records a durable reclaim event", async () => {
  const db = openDatabase({ path: ":memory:" });
  seed(db, true, { path: "C:\\wt\\terminal", label: "child-terminal" });
  const removed: RemoveWorktreeInput[] = [];
  const svc: WorktreeService = {
    async createChildWorktree() { return { path: "", label: "" }; },
    async removeWorktree(input) { removed.push(input); },
  };

  await manager(db, svc).reconcileOrphanedWorktrees();

  assert.deepEqual(removed, [{ parentCwd: "C:\\supervisor", path: "C:\\wt\\terminal" }]);
  assert.equal(eventsOfType(db, "worktree.reclaimed").length, 1);
});

test("leaves a non-terminal-goal worktree untouched", async () => {
  const db = openDatabase({ path: ":memory:" });
  seed(db, false, { path: "C:\\wt\\running", label: "child-running" });
  const removed: RemoveWorktreeInput[] = [];
  const svc: WorktreeService = {
    async createChildWorktree() { return { path: "", label: "" }; },
    async removeWorktree(input) { removed.push(input); },
  };

  await manager(db, svc).reconcileOrphanedWorktrees();

  assert.equal(removed.length, 0);
  assert.equal(eventsOfType(db, "worktree.reclaimed").length, 0);
});

test("records a durable failure and does not throw when removal rejects", async () => {
  const db = openDatabase({ path: ":memory:" });
  seed(db, true, { path: "C:\\wt\\locked", label: "child-locked" });
  const svc: WorktreeService = {
    async createChildWorktree() { return { path: "", label: "" }; },
    async removeWorktree() { throw new Error("worktree is locked"); },
  };

  await assert.doesNotReject(() => manager(db, svc).reconcileOrphanedWorktrees());

  assert.equal(eventsOfType(db, "worktree.reclaimed").length, 0);
  assert.equal(eventsOfType(db, "worktree.reclaim_failed").length, 1);
});

test("an already-absent worktree is a durable no-op with the real git service", async () => {
  const db = openDatabase({ path: ":memory:" });
  const root = mkdtempSync(join(tmpdir(), "reclaim-"));
  const repo = join(root, "repo");
  spawnSync("git", ["init", repo], { encoding: "utf8" });
  writeFileSync(join(repo, "base.txt"), "base\n");
  spawnSync("git", ["add", "base.txt"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=R", "-c", "user.email=r@x.invalid", "commit", "-m", "base"], { cwd: repo });

  // Record a worktree path that was never created (already absent).
  seed(db, true, { path: join(root, "repo-worktrees", "child-gone"), label: "child-gone" });

  const svc = createGitWorktreeService();
  const mgr = createAgentSessionManager({
    goalRepo: createGoalRepository(db), runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db), agentSessionRepo: createAgentSessionRepository(db),
    database: db, worktreeService: svc, supervisorCwd: repo,
  });

  await assert.doesNotReject(() => mgr.reconcileOrphanedWorktrees());
  assert.equal(eventsOfType(db, "worktree.reclaimed").length, 1);
});
