## 1. Durable Domain and Schema

- [x] 1.1 Add domain types and tests for managed task statuses, authoritative criterion outcomes, judge decisions, delivery outcomes, and completion gaps.
- [x] 1.2 Add additive SQLite migrations for `managed_tasks`, `managed_task_criteria`, `managed_task_criterion_results`, `managed_task_reviews`, and `managed_task_deliveries` with foreign keys and uniqueness constraints.
- [x] 1.3 Add a per-task worker attempt number to `agent_delegation_requests` and migrate existing rows safely.
- [x] 1.4 Add database tests proving the new schema initializes on new and pre-change databases without altering historical terminal goal records.

## 2. Managed Task Persistence

- [x] 2.1 Implement a managed-task repository that atomically registers tasks and immutable criteria from accepted task lists.
- [x] 2.2 Implement repository transitions for delegation, awaiting review, rejection, split, failure, blocked, awaiting delivery, and accepted states with validation of legal transitions.
- [x] 2.3 Implement durable attempt and substantive-rejection counters, cited-criterion history, parent/child lineage, and last safe summaries.
- [x] 2.4 Implement persistence and queries for attempt-scoped executor evidence and authoritative criterion results.
- [x] 2.5 Implement persistence and queries for judge review and delivery records linked to worker delegation attempts.
- [x] 2.6 Add transaction helpers and tests proving decision-critical state plus its audit event commit or roll back together.
- [x] 2.7 Add reopen tests proving task state, counters, criteria, reviews, and delivery state survive database restart.

## 3. Replace In-Memory Task Authority

- [x] 3.1 Change accepted task-list handling to register/freeze tasks and criteria through the durable repository before emitting acceptance events.
- [x] 3.2 Change worker delegation gates to read persisted contracts, counters, lineage, and active attempt state instead of `GoalTaskRegistry` memory.
- [x] 3.3 Change worker terminal handling so success records claims and attested evidence but never marks a contracted task accepted by itself.
- [x] 3.4 Port cite-only rejection and two-rejection narrowing behavior to durable repository transitions with restart-boundary tests.
- [x] 3.5 Remove the in-memory task registry as an authoritative gate source after equivalent durable integration tests pass.
- [x] 3.6 Implement fail-closed backfill for non-terminal historical goals, preserving summaries while marking unprovable criterion outcomes `UNKNOWN`.

## 4. Structured Independent Judge

- [x] 4.1 Define and test the strict `managed_review.decision` control-block schema with worker attempt identity, overall verdict, and exactly one decision per frozen criterion.
- [x] 4.2 Update review-role prompts to provide the frozen contract, candidate diff/evidence, attested files, and structured judge output instructions without granting commit authority.
- [x] 4.3 Validate judge output against the targeted worker attempt and reject missing, duplicate, or unknown criterion decisions durably.
- [x] 4.4 Persist valid judge decisions and update authoritative criterion outcomes and rejection counts exactly once per reviewed attempt.
- [x] 4.5 Preserve uncited or out-of-contract objections as deferred findings without changing task or criterion state.
- [x] 4.6 Add managed-session integration tests for accepted, rejected, blocked, malformed, duplicate, and incomplete judge decisions.

## 5. Backend-Owned Delivery

- [x] 5.1 Implement a delivery service that verifies the reviewed worker worktree still matches the persisted attestation before delivery.
- [x] 5.2 Implement runtime-owned candidate commit creation from attested worker changes and record typed failures when candidate creation cannot be verified.
- [x] 5.3 Require and persist a clean supervisor workspace checkpoint before applying a candidate commit.
- [x] 5.4 Apply accepted candidates through backend git operations and run the configured fixed validation command independently of judge claims.
- [x] 5.5 Persist committed delivery evidence including validation output and commit SHA, then mark the task accepted only after delivery succeeds.
- [x] 5.6 Restore and verify the supervisor checkpoint after apply or validation failure and persist conflict, reverted, revert-failed, and verification-failed outcomes.
- [x] 5.7 Add filesystem-backed tests for successful commit, stale worktree, dirty supervisor workspace, conflict, test failure with verified rollback, and rollback failure.

## 6. Completion Gate and Context Projection

- [x] 6.1 Implement a completion evaluator that returns structured gaps for unaccepted leaf tasks, non-PASS criteria, active attempts/reviews/deliveries, undelivered attested changes, uncontracted-only work, and unarchived planned changes.
- [x] 6.2 Change `managed_delegation.complete` handling from unconditional completion to a backend-evaluated completion request.
- [x] 6.3 Atomically complete run/goal state and terminal events only when the completion evaluator reports no gaps.
- [x] 6.4 Feed rejected completion gaps into the next supervisor continuation without losing the durable task history.
- [x] 6.5 Replace in-memory continuation task history with a context projection built from durable task, attempt, criterion, review, and delivery repositories plus bounded safe summaries.
- [x] 6.6 Add tests for flat tasks, split descendants, planned changes, text-only accepted tasks, file-producing delivered tasks, pending reviews, failed delivery, and restart-equivalent completion decisions.

## 7. Integration and Verification

- [x] 7.1 Update backend goal/session snapshots and dashboard-compatible read models to expose safe durable task, judge, and delivery status without raw provider payloads.
- [x] 7.2 Add an end-to-end mock managed run covering task registration, worker claim, judge decision, backend delivery, completion rejection with gaps, and final accepted completion.
- [x] 7.3 Add a restart integration test that closes and reopens SQLite between worker, review, delivery, and completion phases.
- [x] 7.4 Update runtime and architecture documentation to distinguish AI transcript records from authoritative structured state and document the compatibility use of the `review_merge` role id as Judge.
- [x] 7.5 Run focused persistence/runtime/backend tests, `npm run typecheck`, the full test suite, and `openspec validate add-durable-task-completion-gate --strict`.
- [x] 7.6 Run one live managed-provider smoke test and document whether structured judge decisions and backend-owned delivery work without fixture-only metadata injection.
