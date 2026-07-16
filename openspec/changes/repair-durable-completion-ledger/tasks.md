## 1. Test-first regression fixtures

- [x] 1.1 Add persistence tests for fresh, true legacy, initialized-clean, initialized-corrupt, ambiguous-provenance, and terminal-blocked databases before changing migration code; assert first-open results, second-open equality, migration diagnostics, raw audit preservation, and `PRAGMA foreign_key_check`.
- [x] 1.2 Add a frozen-contract restart test in which a synthetic spec task starts with `S1`–`S3`, a later task list records an ignored A/B mutation, and reopen preserves only `S1`–`S3`.
- [x] 1.3 Add completion-evaluator tests covering accepted changed candidates awaiting delivery, committed delivery, Judge-rejected changed candidates, rejected-then-accepted retry, superseded terminal attempts, and candidate-bound integration delivery.
- [x] 1.4 Add a two-Goal regression fixture using the same logical task ID and prove that active attempts, reviews, integrations, deliveries, and undelivered candidates from one Goal never appear in the other's completion result.
- [x] 1.5 Add a manager-level restart/retry regression reproducing the observed staged pipeline: ignored synthetic criteria, backend restart, first implementation attempt rejected, later attempt accepted and committed, valid completion, and no continuation exhaustion.
- [x] 1.6 Add prompt and continuation tests that distinguish no completion signal from a rejected valid completion request, preserve the last structured gaps at the bound, and instruct planned supervisors not to restate synthetic spec tasks.

## 2. Versioned managed-task migrations

- [x] 2.1 Add a named `schema_migrations` ledger and pre-initialization schema inspection so fresh, true legacy, and already-initialized databases select distinct migration paths.
- [x] 2.2 Move historical managed-task event backfill behind a one-time transactional migration that runs only when the managed-task ledger was absent and records its marker atomically.
- [x] 2.3 Implement authoritative contract provenance from the earliest backend-created synthetic contract or accepted creating task list, treating worker delegation acceptance only as corroborating evidence.
- [x] 2.4 Implement the targeted ignored-mutation repair: remove only conclusively replay-added criteria and their derived criterion-result rows, preserve raw events/delegations/results/reviews, and record bounded diagnostics for repaired and ambiguous tasks.
- [x] 2.5 Preserve `blocked`, `completed`, `failed`, and `cancelled` Goal status, timestamps, runs, sessions, and event history during migration, and assert migration never starts or resumes runtime work.
- [x] 2.6 Verify migration re-entry after success and after a simulated transactional failure: successful reopen is a no-op, while failed work and its marker roll back together.

## 3. Goal-scoped delivery-obligation evaluation

- [x] 3.1 Introduce a candidate-bound delivery-obligation projection derived from attested changes, authoritative accepted Judge decisions, integration identity, and durable delivery disposition.
- [x] 3.2 Exclude rejected, blocked, malformed, abandoned, and superseded historical candidates from open delivery obligations while retaining their durable audit records.
- [x] 3.3 Require a matching committed delivery for each current accepted changed candidate and retain independent gaps for genuinely active attempts, reviews, integrations, and deliveries.
- [x] 3.4 Rewrite completion-evaluator attempt and candidate queries to join through the owning Goal and internal managed-task ID instead of resolving by logical task ID alone.
- [x] 3.5 Update completion-gap and continuation diagnostics so evaluated-but-rejected completion requests are distinct from completion-less exits and exhaustion reports failure to reach successful completion with the last safe gaps.

## 4. Supervisor contract alignment

- [x] 4.1 Update bootstrap and continuation guidance to state that change-plan acceptance already registered synthetic `spec:<changeId>` tasks with backend-authored frozen criteria and that later task lists announce implementation tasks only.
- [x] 4.2 Keep defensive mutation handling intact and add restart coverage proving a supervisor restatement remains ignored by both live registration and migration/backfill.

## 5. Product-level verification

- [x] 5.1 Run focused persistence, managed-task repository, completion-evaluator, restart-rehydration, manager, prompt, and backend snapshot tests, then run `npm run typecheck` and the full `npm test` suite. Verification: focused suites passed; typecheck passed; full Node 24 suite passed 568/569 with only the pre-existing macOS `/var` vs `/private/var` path-string assertion excluded from this change.
- [x] 5.2 Open a disposable copy of the reported blocked-ledger shape twice, verify only provably polluted criteria are repaired, migration diagnostics are stable, foreign keys are clean, and the original blocked Goal lifecycle remains unchanged.
- [x] 5.3 Run a scratch broad staged managed Goal with a backend restart and rejected-then-accepted retry; require all leaf tasks accepted, all authoritative criteria `PASS`, no open delivery obligations, one `goal.completed`, and zero `supervisor.continuations_exhausted` events.
- [x] 5.4 Verify existing Goal/session REST snapshot and provider control-block schemas remain unchanged, and document any intentionally unresolved ambiguous historical rows as fail-closed follow-up data.
- [x] 5.5 Run strict OpenSpec validation for this change and `git diff --check`, recording the exact commands and successful outputs with the implementation handoff.
