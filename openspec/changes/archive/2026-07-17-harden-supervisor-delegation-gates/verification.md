# Verification — harden-supervisor-delegation-gates

## Reproduction → acceptance (the three high-severity gaps)

All three desired-behavior tests were first run against master `37f3e08` and
failed on the intended assertion (verbatim failures in `repro/evidence.md`).
After implementation, each passes in the suite:

- **REPRO-H4** "a validated spec result requires a Supervisor review gate
  before review-merge" — `change.spec_review_requested` is now emitted after
  structural validation, and a review-merge without approval is rejected
  durably. PASS.
- **REPRO-H5** "spec retry-budget exhaustion blocks the change but keeps the
  goal alive" — `change.blocked` for the change, no `goal.blocked`, goal stays
  `running`. PASS.
- **REPRO-H6** "reworded gaps with identical refs still trip the circuit
  breaker" — identical ref-sets with different prose block the goal via
  `supervisor.reassessment_circuit_breaker`. PASS.

## Automated tests

- `npm test` — **676 tests, 662 pass, 0 fail, 14 skipped** (pre-existing
  skips). `npm run typecheck` — clean. All green at every group commit
  (`00639b0`, `9877d5e`, `7f1d56c`, `8e2b224`).
- Event-pump containment: a control-path fault records a durable
  `runtime.event_pump_failed` error event and fails session/run/goal visibly;
  the previously-rejecting registration-failure test was rewritten to assert
  the contained behavior (no scaffold + durable failure).
- Spec approval gate: registry state machine (idempotent same-verdict
  duplicates, conflicting-verdict guidance, attempt-started invalidation),
  control-event validation, approval-gated review-merge dispatch AND post-merge
  re-check (`change.spec_merge_ungated` on mismatch — no silent return),
  zero-attestation delivery rejection, post-merge validation failure durably
  reopening the accepted task, verbatim rejection feedback in the corrective
  prompt, and full restart rehydration (including legacy `change.spec_approved`
  replay).
- Change-scoped budget: durable and in-memory budget paths both block only the
  change; reassessment/completion gates treat blocked changes as terminal
  (archived-or-blocked); the durable completion evaluator excludes
  blocked-change tasks so re-planned goals stay completable; e2e test drives
  budget exhaustion → change blocked → unsatisfied reassessment referencing the
  blocked scope → next-epoch plan admitted.
- Structured gaps: shape validation with teaching rejections (plain strings,
  empty/unknown refs), ref resolution against change ids / task ids /
  `openspec/specs` capabilities / `new:` declarations, blocked-change reference
  requirement, ref-set breaker signature (prose excluded), distinct-refs
  admission, projection/dashboard/rehydration carrying structured gaps with
  legacy prose tolerance.

## Live smoke

Backend booted via `tsx src/backend/server.ts` (PORT=3411, dev SQLite freshly
reset per task 5.1).

1. **Mock provider end-to-end**: goal created → started
   (`providerOverride: {provider: "mock"}`) → `goal.completed` with a
   14-event durable timeline (`goal.created` … `run.completed`,
   `goal.completed`). Boot/API regression clean.
2. **Codex-managed run, attempt 1 (real `codex` CLI 0.2.3)**: started with a
   stale model label (`gpt-5-codex`, not in this CLI's catalog). The run
   failed **visibly**: durable `error` event with the CLI message, run and
   goal `failed` — live confirmation of the Group 1 containment posture (no
   silent hang, no stuck `running`).
3. **Codex-managed run, attempt 2 (`gpt-5.6-terra`)**: goal "Tiny notes CLI"
   (two deliverables). The supervisor declared a change plan (epoch 1),
   activated `notes-storage`, and the new gate chain fired live:
   - `change.spec_review_requested` after the spec worker's validated result;
   - `change.spec_supervisor_approved` bound to the validated attempt;
   - the supervisor then re-delegated a spec attempt (approval invalidated by
     design), the corrective attempt re-validated, a second
     `change.spec_review_requested` and a second approval landed — the
     one-decision-per-attempt machinery absorbed the LLM's wobble without a
     conflicting-decision loop;
   - every deviation was durably rejected with a safe reason: task-id-for-
     attempt-id confusion ("stale; current validated spec attempt is
     <id>" — the supervisor self-corrected from this), review-merge with an
     unresolvable worker id, and implementation delegation while still
     specifying.
   Live finding (follow-up filed, not a gate defect): the "Review merge
   requires an existing worker result." rejection does not name the correct
   attempt id the way the stale spec-review rejection does, which slows the
   supervisor's self-correction.

   Outcome: after 176 events / 9 durable rejections / 6 continuations the
   supervisor was still looping on the worker-id confusion, so the run was
   cancelled by operator via `POST /api/agent-sessions/:id/cancel` (goal
   terminal). The smoke's target — the approval gate chain firing and
   holding under a real LLM, with every deviation rejected durably and
   nothing failing silently — was met before cancellation; the remaining
   wobble is the affordance follow-up above, not an enforcement gap.

## Note on live non-determinism

Forcing a spec-budget exhaustion or a repeated-gap breaker trip requires a
real supervisor LLM to fail in specific ways on demand; per the precedent in
`archive/2026-07-16-write-ahead-delivery-git-reconciliation/verification.md`,
those deterministic paths are proven by the manager tests against the same
SQLite/git substrate the live path uses, and the live smoke's job is the
gate's happy path plus boot/API regression.
