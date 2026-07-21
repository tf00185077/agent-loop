import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
  filteredStatusSummary,
  isWorkspaceStatusClean,
  runtimeDatabaseIgnorePaths,
  significantStatusEntries,
} from "./workspace-cleanliness.js";

const cwd = resolve("C:/repo");
const ignored = runtimeDatabaseIgnorePaths(resolve("C:/repo/data/auto-agent.sqlite"));

test("a workspace whose only changes are the runtime DB files is clean", () => {
  const status = [
    " M data/auto-agent.sqlite",
    " M data/auto-agent.sqlite-wal",
    "?? data/auto-agent.sqlite-shm",
  ].join("\n");
  assert.equal(isWorkspaceStatusClean(status, cwd, ignored), true);
  assert.equal(filteredStatusSummary(status, cwd, ignored), "");
});

test("a real change makes the workspace dirty, alone or alongside the DB", () => {
  assert.equal(isWorkspaceStatusClean(" M src/foo.ts", cwd, ignored), false);
  const mixed = " M data/auto-agent.sqlite\n M src/foo.ts";
  assert.equal(isWorkspaceStatusClean(mixed, cwd, ignored), false);
  // The summary names only the real change, never the DB (2-char porcelain status).
  assert.equal(filteredStatusSummary(mixed, cwd, ignored), " M src/foo.ts");
});

test("an empty ignored set reproduces raw emptiness", () => {
  assert.equal(isWorkspaceStatusClean(" M data/auto-agent.sqlite", cwd, []), false);
  assert.equal(isWorkspaceStatusClean("", cwd, []), true);
});

test("a subdirectory cwd resolves ignored paths correctly", () => {
  // git run from the repo root reports paths relative to root; the DB abs path
  // still matches regardless of the reported relative form.
  const status = " M data/auto-agent.sqlite";
  assert.equal(isWorkspaceStatusClean(status, cwd, ignored), true);
  // A status run from a subdir would report the DB relative to that subdir; the
  // absolute resolution against that cwd still matches when the file is there.
  const subCwd = resolve("C:/repo/data");
  assert.equal(isWorkspaceStatusClean(" M auto-agent.sqlite", subCwd, ignored), true);
});

test("rename lines are judged by their target path", () => {
  assert.equal(isWorkspaceStatusClean("R  old.ts -> src/new.ts", cwd, ignored), false);
  assert.deepEqual(
    significantStatusEntries("R  a.ts -> b.ts", cwd, ignored).map((e) => e.path),
    ["b.ts"],
  );
});

test("runtimeDatabaseIgnorePaths handles absent and in-memory databases", () => {
  assert.deepEqual(runtimeDatabaseIgnorePaths(undefined), []);
  assert.deepEqual(runtimeDatabaseIgnorePaths(":memory:"), []);
  const paths = runtimeDatabaseIgnorePaths(resolve("C:/repo/data/db.sqlite"));
  assert.equal(paths.length, 4);
  assert.ok(paths.some((p) => p.endsWith("-wal")));
  assert.ok(paths.some((p) => p.endsWith("-shm")));
});
