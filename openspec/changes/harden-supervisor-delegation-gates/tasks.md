# Tasks: Harden Supervisor Delegation Gates

Reference implementation for group 2: branch `codex/supervisor-spec-approval`
(commits 41b9588..6e65a9d) — treat as reference material, not a merge source;
requirements D2/D3 (idempotent duplicates, guarded transitions) deliberately
differ from it. Repro tests live in `repro/repro-tests.ts`; move them (adapted)
into the manager test suite as each group lands. TDD throughout: failing test
first. Commit at the end of every task group.

## 1. Event-pump fault containment (D3, smallest and unblocks everything)

- [x] 1.1 Failing test: an adapter event whose control handling throws leaves a durable error event and a visibly failed run — no unhandled rejection, no goal stuck `running`
- [x] 1.2 Add terminal catch in `runSessionEvents` persisting a sanitized durable error event and failing the run; keep `PostCommitCacheRefreshInterruption` passthrough semantics
- [x] 1.3 Full suite + typecheck green; commit

## 2. Supervisor spec approval gate (REPRO-H4, new capability supervisor-spec-approval)

- [ ] 2.1 Move REPRO-H4 into the manager test suite as the failing acceptance test
- [ ] 2.2 Change-registry spec-review state machine: validated-attempt tracking, one decision per attempt, idempotent same-verdict duplicates (summary excluded from identity), conflicting-verdict rejection with next-action guidance, attempt-started invalidation
- [ ] 2.3 Control-event validation for `managed_change.spec_review` (change id, worker delegation request id, approve/reject, non-empty summary)
- [ ] 2.4 Manager routing: backend-initiated `change.spec_review_requested` + bounded packet (path-hardened reads, truncation marker, visible missing-worktree message); approval-gated review-merge dispatch; guarded durable transition on reject (illegal status → durable rejection, never throw); verbatim rejection feedback in corrective prompt appendix
- [ ] 2.5 Zero-attestation spec deliveries rejected durably (scenario in goal-scale-decomposition delta)
- [ ] 2.6 Post-merge gate re-check records a durable event on failure (no silent `return`); rename `change.spec_approved` → `change.spec_merged`
- [ ] 2.7 Rehydration replays review-requested / decision / attempt-started / spec-merged events to identical gate outcomes; restart test
- [ ] 2.8 Supervisor prompt contract: spec_review control block + flow steps (informational)
- [ ] 2.9 Full suite + typecheck green; commit

## 3. Change-scoped spec budget (REPRO-H5)

- [ ] 3.1 Move REPRO-H5 into the manager test suite as the failing acceptance test
- [ ] 3.2 Split `blockChangeAndGoal`: spec-budget path blocks only the change (`change.blocked`, goal untouched) and returns the reassess-and-re-plan observation
- [ ] 3.3 Reassessment timing gate: archived-or-blocked satisfies the gate; unsatisfied reassessment must reference every blocked change in its gaps (depends on 4.2 for structured refs — land the archived-or-blocked half first, the reference check with group 4)
- [ ] 3.4 End-to-end test: spec budget exhausts → change blocked, goal running → reassessment referencing blocked scope → next-epoch plan admitted
- [ ] 3.5 Full suite + typecheck green; commit

## 4. Structured gap identity for the circuit breaker (REPRO-H6, BREAKING control-block schema)

- [ ] 4.1 Adapt REPRO-H6 to structured gaps (same refs, different summaries) and add it failing
- [ ] 4.2 Control-event validation: `remainingGaps` as `{refs[], summary}`; refs resolve to change ids / task ids / `openspec/specs` capabilities or `new:<kebab-case>`; teaching safe reasons for plain strings, empty refs, unknown refs
- [ ] 4.3 Breaker signature = sorted deduplicated ref-set union; prose excluded; distinct-refs admission test
- [ ] 4.4 Durable reassessment events carry structured gaps; rehydration + dashboard timeline rendering of gap refs
- [ ] 4.5 Supervisor prompt contract: structured gap format with example (informational)
- [ ] 4.6 Full suite + typecheck green; commit

## 5. Verification and closeout

- [ ] 5.1 Reset dev SQLite state (documented; schema/event changes are not migrated for in-flight dev goals)
- [ ] 5.2 Live smoke per CLAUDE.md: start API, create+start a planned goal, drive spec review → approval → merge, force one spec-budget block and one reworded-gap breaker trip; record timeline evidence in `verification.md`
- [ ] 5.3 Delete `repro/` (tests now live in the suite), sync delta specs, archive the change
