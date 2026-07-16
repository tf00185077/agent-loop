## 1. Persistence identity regression coverage

- [ ] 1.1 Add a managed-task repository test proving two goals can register the same logical task identifier, receive distinct internal UUIDs, and mutate/query only their own records.
- [ ] 1.2 Add a legacy-database migration fixture with parent lineage, criteria, delegation attempts, review, integration, and delivery rows; assert logical history, internal UUID stability across reopen, and an empty `PRAGMA foreign_key_check` result.

## 2. UUID-backed managed task persistence

- [ ] 2.1 Change the fresh SQLite schema to store an opaque UUID primary key plus non-null `logical_task_id` with `UNIQUE (goal_id, logical_task_id)`, keeping managed child foreign keys on the internal UUID.
- [ ] 2.2 Implement an idempotent legacy managed-task identity migration that rewrites parent and child references through one old-ID-to-UUID map and restores foreign-key enforcement before startup continues.
- [ ] 2.3 Update managed-task row mapping and repository registration so public records/events retain logical IDs while persistence relations use internal UUIDs.

## 3. Goal-scoped runtime resolution

- [ ] 3.1 Require goal context on every repository operation that resolves a logical task identifier, and add negative tests proving a task owned only by another goal cannot be read or mutated.
- [ ] 3.2 Update agent-session orchestration, completion evaluation, restart recovery, context projection, and related fixtures to pass goal context without exposing internal UUIDs.
- [ ] 3.3 Add a manager-level two-goal regression test proving the same synthetic `spec:<changeId>` identifier can be registered and delegated independently with logical IDs in durable events.

## 4. Durable-before-Git change plan handling

- [ ] 4.1 Add a failing change-plan test whose durable registration rejects and assert that OpenSpec scaffold/Git operations are never invoked.
- [ ] 4.2 Reorder change-plan handling so accepted plan state, synthetic tasks, and durable plan intent are persisted before materialization, then record every scaffold outcome durably.
- [ ] 4.3 Add materialization-failure coverage proving durable plan/task state remains observable and contains a sanitized failure reason.

## 5. Verification

- [ ] 5.1 Run focused persistence and agent-session tests, `npm run typecheck`, and the full `npm test` suite.
- [ ] 5.2 Run `openspec validate scope-managed-task-identities` and a scratch-database smoke that starts two goals using the same synthetic logical task identifier without a collision or cross-goal projection.
- [ ] 5.3 Record the commands, outputs, migration evidence, same-name-goal evidence, Git-side-effect evidence, and remaining limitations in `verification.md`.
