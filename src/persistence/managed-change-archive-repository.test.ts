import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createGoalRepository } from "./goal-repository.js";
import { createManagedChangeArchiveRepository } from "./managed-change-archive-repository.js";

const identity = {
  goalId: "goal-a",
  changeId: "change-a",
  sourcePath: "/workspace/openspec/changes/change-a",
  targetPath: "/workspace/openspec/changes/archive/2026-07-17-change-a",
  manifestDigest: "a".repeat(64),
  preArchiveHead: "head-before",
};

test("persists one fixed archive intent and final event exactly once", () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "Archive", description: "Intent" });
  const scopedIdentity = { ...identity, goalId: goal.id };
  const archive = createManagedChangeArchiveRepository(db, { now: () => "2026-07-17T00:00:00.000Z" });

  const pending = archive.beginIntent(scopedIdentity);
  assert.equal(pending.status, "pending");
  assert.equal(archive.beginIntent(scopedIdentity).id, pending.id);
  assert.throws(() => archive.beginIntent({ ...scopedIdentity, targetPath: `${identity.targetPath}-other` }), /ambiguous|mismatch/i);

  const committed = archive.finalize({
    goalId: goal.id,
    changeId: identity.changeId,
    archiveCommitSha: "head-after",
    runId: null,
    safeSummary: "Backend archive committed.",
  });
  assert.equal(committed.status, "committed");
  assert.equal(archive.finalize({
    goalId: goal.id,
    changeId: identity.changeId,
    archiveCommitSha: "head-after",
    runId: null,
    safeSummary: "Replay.",
  }).id, pending.id);
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM events
    WHERE goal_id = ? AND json_extract(data, '$.runtimeEventType') = 'change.archived'
  `).pluck().get(goal.id), 1);
  db.close();
});

test("archive finalization and event roll back together on a fault", () => {
  const db = openDatabase({ path: ":memory:" });
  const goal = createGoalRepository(db).create({ title: "Archive", description: "Fault" });
  const archive = createManagedChangeArchiveRepository(db, {
    fault(point) {
      if (point === "before_final_event") throw new Error("injected final event fault");
    },
  });
  archive.beginIntent({ ...identity, goalId: goal.id });

  assert.throws(() => archive.finalize({
    goalId: goal.id,
    changeId: identity.changeId,
    archiveCommitSha: "head-after",
    runId: null,
    safeSummary: "Backend archive committed.",
  }), /injected final event fault/);
  assert.equal(archive.get(goal.id, identity.changeId)?.status, "pending");
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM events
    WHERE goal_id = ? AND json_extract(data, '$.runtimeEventType') = 'change.archived'
  `).pluck().get(goal.id), 0);
  db.close();
});
