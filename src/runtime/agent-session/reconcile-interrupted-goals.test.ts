import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase, type AppDatabase } from "../../persistence/database.js";
import { createGoalRepository } from "../../persistence/goal-repository.js";
import { createManagedTaskRepository } from "../../persistence/managed-task-repository.js";
import { createAgentSessionRepository, createEventRepository, createRunRepository } from "../../persistence/runtime-repositories.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createGitWorktreeService } from "./worktree-service.js";
import { createManagedDeliveryService } from "./managed-delivery-service.js";

const CAPS = { eventStreaming: true, approval: false, cancellation: true, resume: false, childSessions: true };

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "reconcile-goal-"));
  const repo = join(root, "repo");
  spawnSync("git", ["init", repo], { encoding: "utf8" });
  writeFileSync(join(repo, "base.txt"), "base\n");
  spawnSync("git", ["add", "base.txt"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=R", "-c", "user.email=r@x.invalid", "commit", "-m", "base"], { cwd: repo });
  return repo;
}
const git = (repo: string, args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });

function managerFor(db: AppDatabase, supervisorCwd: string) {
  return createAgentSessionManager({
    goalRepo: createGoalRepository(db), runRepo: createRunRepository(db),
    eventRepo: createEventRepository(db), agentSessionRepo: createAgentSessionRepository(db),
    managedTaskRepo: createManagedTaskRepository(db), database: db,
    worktreeService: createGitWorktreeService(), managedDeliveryService: createManagedDeliveryService(),
    supervisorCwd,
  });
}

function recoveryEvents(db: AppDatabase): Array<Record<string, unknown>> {
  return (db.prepare("SELECT data FROM events").all() as Array<{ data: string }>)
    .map((r) => JSON.parse(r.data) as Record<string, unknown>)
    .filter((d) => d.runtimeEventType === "recovery.reconciled");
}

test("reconciles a restart-interrupted goal: reset delivery, interrupt attempt, reset task, interrupted status", () => {
  const repo = gitRepo();
  const checkpoint = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const db = openDatabase({ path: join(mkdtempSync(join(tmpdir(), "reconcile-db-")), "r.sqlite") });
  const goals = createGoalRepository(db);
  const runs = createRunRepository(db);
  const sessions = createAgentSessionRepository(db);
  const tasks = createManagedTaskRepository(db);

  const goal = goals.create({ title: "Interrupted", description: "d" });
  goals.updateStatus(goal.id, "running", { startedAt: "2026-07-16T00:00:00.000Z" });
  const run = runs.create({ goalId: goal.id, provider: "mock", model: "m" });
  const supervisor = sessions.createSession({
    goalId: goal.id, runId: run.id, providerId: "mock", modelLabel: "m", lifecycleState: "running", capabilities: CAPS,
  });
  tasks.registerTasks({ goalId: goal.id, tasks: [{ id: "task-1", title: "T", acceptance: [{ id: "A1", text: "x" }] }] });

  // In-flight worker attempt with a real worktree.
  const worktree = createGitWorktreeService().createChildWorktree({ parentCwd: repo, childSessionId: "child-1" });
  return worktree.then((wt) => {
    const worker = sessions.createDelegationRequest({ parentSessionId: supervisor.id, role: "worker", taskId: "task-1", promptSummary: "w" });
    tasks.beginAttempt("task-1", worker.id);
    const childRun = runs.create({ goalId: goal.id, provider: "mock", model: "m" });
    const child = sessions.createSession({
      goalId: goal.id, runId: childRun.id, providerId: "mock", modelLabel: "m", lifecycleState: "running", capabilities: CAPS, worktree: wt,
    });
    sessions.acceptDelegationRequest(worker.id);
    sessions.startDelegationRequest(worker.id, child.id);

    // A pending delivery whose candidate was cherry-picked onto the supervisor
    // (git ahead of the checkpoint) but never recorded committed — a mid-delivery crash.
    writeFileSync(join(wt.path, "feature.txt"), "delivered\n");
    const prepared = createManagedDeliveryService().prepareCandidate({
      workerCwd: wt.path, supervisorCwd: repo, attestedFiles: ["feature.txt"], safeSummary: "Deliver",
    });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    tasks.recordDelivery({
      taskId: "task-1", workerDelegationRequestId: worker.id, status: "pending",
      checkpointHead: prepared.checkpointHead, candidateCommitSha: prepared.candidateCommitSha, safeSummary: "pending",
    });
    git(repo, ["cherry-pick", prepared.candidateCommitSha]);
    assert.notEqual(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);

    managerFor(db, repo).recoverOrphanedSessions();

    assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint, "supervisor reset to checkpoint");
    assert.equal(goals.getById(goal.id)?.status, "interrupted");
    assert.equal(tasks.getTask("task-1")?.status, "registered");
    assert.equal(tasks.getTask("task-1")?.attemptCount, 0);
    assert.equal(sessions.listInFlightWorkerAttemptsForGoal(goal.id).length, 0, "attempt interrupted");
    const evt = recoveryEvents(db);
    assert.equal(evt.length, 1);
    assert.equal(evt[0]?.deliveriesReset, 1);
    assert.equal(evt[0]?.attemptsInterrupted, 1);
    assert.equal(evt[0]?.tasksReset, 1);
    db.close();
  });
});

test("an idle goal with a live session is still moved to interrupted with no workspace change", () => {
  const repo = gitRepo();
  const checkpoint = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const db = openDatabase({ path: join(mkdtempSync(join(tmpdir(), "reconcile-idle-")), "r.sqlite") });
  const goals = createGoalRepository(db);
  const run = createRunRepository(db).create({ goalId: goals.create({ title: "Idle", description: "d" }).id, provider: "mock", model: "m" });
  const goalId = (db.prepare("SELECT id FROM goals").get() as { id: string }).id;
  goals.updateStatus(goalId, "running", { startedAt: "2026-07-16T00:00:00.000Z" });
  createAgentSessionRepository(db).createSession({
    goalId, runId: run.id, providerId: "mock", modelLabel: "m", lifecycleState: "running", capabilities: CAPS,
  });

  managerFor(db, repo).recoverOrphanedSessions();

  assert.equal(goals.getById(goalId)?.status, "interrupted");
  assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), checkpoint);
  assert.equal(recoveryEvents(db).length, 1);
  db.close();
});

test("recovery is idempotent across restarts", () => {
  const repo = gitRepo();
  const db = openDatabase({ path: join(mkdtempSync(join(tmpdir(), "reconcile-idem-")), "r.sqlite") });
  const goals = createGoalRepository(db);
  const run = createRunRepository(db).create({ goalId: goals.create({ title: "Idem", description: "d" }).id, provider: "mock", model: "m" });
  const goalId = (db.prepare("SELECT id FROM goals").get() as { id: string }).id;
  goals.updateStatus(goalId, "running", { startedAt: "2026-07-16T00:00:00.000Z" });
  createAgentSessionRepository(db).createSession({
    goalId, runId: run.id, providerId: "mock", modelLabel: "m", lifecycleState: "running", capabilities: CAPS,
  });

  const mgr = managerFor(db, repo);
  mgr.recoverOrphanedSessions();
  mgr.recoverOrphanedSessions();

  assert.equal(goals.getById(goalId)?.status, "interrupted");
  assert.equal(recoveryEvents(db).length, 1, "no duplicate recovery event on the second boot");
  db.close();
});
