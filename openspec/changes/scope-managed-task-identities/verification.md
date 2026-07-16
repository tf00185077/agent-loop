# Verification

## Automated checks

- `npm test`: 524 tests, 511 passed, 13 skipped, 0 failed.
- `npm run typecheck`: passed with no TypeScript diagnostics.
- `openspec validate scope-managed-task-identities`: passed.
- `git diff --check`: passed.

## Regression evidence

- The repository regression first reproduced the original collision: registering `spec:plan-foundation` for a second goal failed because the logical identifier was the database-wide primary key. With the UUID-backed schema, both goals retain the same public logical ID, have distinct internal UUIDs, and goal-scoped reads and mutations cannot cross the boundary.
- The legacy fixture includes a parent/child task graph, criterion and result rows, delegation history, review, integration, and delivery records. Opening the fixture rewrites every relation through one old-ID-to-UUID map, preserves public logical IDs and history, reports no `PRAGMA foreign_key_check` violations, rejects a null logical ID, and retains the same UUIDs after reopen.
- The manager-level regression starts two goals that emit identical synthetic IDs (`spec:feature-a` and `spec:feature-b`). Both plans persist independently, durable projections expose only logical IDs, and the underlying UUIDs differ.
- The durable-registration failure regression rejects persistence before materialization and records zero scaffold/Git calls. The materialization-failure regression proves the accepted plan and tasks remain durable and a sanitized `runtime.openspec_materialization_failed` event is recorded.

## Scratch database smoke

A temporary database registered two goals with the logical task ID `spec:plan-foundation` and produced:

- 2 managed-task rows;
- 2 distinct internal IDs;
- the same logical ID in both public projections;
- a cross-goal lookup miss;
- 0 foreign-key violations.

The workspace database was copied to a temporary file and reopened twice. It already contained the migrated column because the local development process had opened it during implementation; the copied database retained opaque IDs, stable IDs across reopen, and 0 foreign-key violations. Legacy-schema conversion itself is covered by the isolated pre-migration fixture above.

## Remaining limitations

- Logical task IDs are unique only within a goal. Callers that lack goal context may use the compatibility overload only while the logical ID is globally unambiguous; duplicate matches fail closed instead of guessing.
- The migration is intentionally one-way. Restoring an older application version against an upgraded database is not supported.
- The runtime workspace SQLite file changed while testing and is deliberately excluded from the implementation commit.
