# Design: Harden Supervisor Delegation Gates

## Context

Three defects reproduced against master `37f3e08` (failing desired-behavior tests in `repro/repro-tests.ts`, evidence in `repro/evidence.md`):

1. **No semantic spec review.** `approveSpecChangeAfterMerge` advances a change to `executing` on structural validation alone. Nobody with goal context ever judges whether the spec's content matches the change's intent.
2. **Goal-terminal spec budget.** `blockChangeAndGoal` fires when spec authoring exhausts its retry budget; the goal is terminally `blocked` even though multi-epoch re-planning exists to route around dead scope. The reassessment timing gate compounds this: blocked changes count as "unarchived", so even a running goal could never reassess past one.
3. **Prose-keyed circuit breaker.** `reassessmentGapSignature` is lowercase/whitespace-normalized text. Any paraphrase defeats it; only the epoch budget (default 5) bounds a non-converging loop.

Constraints (project invariants that must not regress):
- Prompt text is not enforcement; every rule lands in a backend validator.
- Durable events precede streaming; in-memory registries are rehydratable projections.
- Degrade visibly, never silently.
- The `codex/supervisor-spec-approval` branch already implements most of defect 1's fix and carries live-run learning; it also has two known defects of its own that this design corrects (see Decisions 2 and 3).

## Goals / Non-Goals

**Goals:**
- Deterministic Supervisor approval gate between spec validation and review-merge.
- Change-scoped (not goal-scoped) consequence for spec budget exhaustion, with a durable re-planning path through the existing reassessment/next-epoch machinery.
- Repeated-gap detection that an LLM cannot bypass by rewording, using only exact comparisons over validated identifiers.
- Crash-free control-event handling on every new path (guarded transitions, no unhandled rejections).

**Non-Goals:**
- Human approval UI; judge-role changes; delivery/integration changes; any fuzzy text matching; preserving in-flight dev goals across the schema changes.

## Decisions

### D1. Spec review is a stateful backend gate keyed to one validated attempt

After a spec worker result passes structural validation (S1–S3) in its worktree, the backend — not the supervisor — emits `change.spec_review_requested` (durable) carrying the worker delegation request id, marks that id as the change's sole reviewable attempt, and appends a bounded review packet (proposal.md + specs + tasks.md, 12k-char cap, path-traversal-hardened reads) to the supervisor continuation. `managed_change.spec_review` control blocks are validated against that id: stale, unknown-change, inactive-change, and empty-summary decisions are rejected durably. Approval unlocks review-merge for exactly that attempt; dispatching a new spec attempt clears any prior approval (durably replayable via the attempt-started audit event). Rejection feedback is injected verbatim into the corrective worker's prompt appendix.

*Why this shape:* it is the `codex/supervisor-spec-approval` branch's design, which already survived live-run iteration. Alternative — judge-side semantic review — rejected: the judge has no goal-level context and the project separates structural judging from intent approval.

### D2. Duplicate decisions are idempotent by (attempt, decision); summaries never participate in identity

A repeated decision for the same attempt with the same verdict is accepted as a no-op duplicate regardless of summary wording; only an opposite verdict for the same attempt is rejected as conflicting, with a safe reason that states the standing decision and the correct next action ("already approved — request review-merge for attempt X"). This corrects the branch defect where exact-summary matching classified a reworded re-approval as "conflicting", inviting the supervisor to destroy its own approval by re-delegating.

*Alternative — keep exact-text matching:* rejected; LLMs paraphrase, and the failure chain (reworded approve → "conflicting" → re-delegate → approval wiped → budget burned) was identified as a plausible goal-killer.

### D3. Every durable transition on a control-event path is guarded

The spec-review reject path transitions the managed task only when its durable status legally allows it (mirror of the existing `status === "accepted"` guard on the post-merge path); an illegal state records a durable `delegation.rejected` with the observed status instead of throwing. Additionally `runSessionEvents` gains a terminal catch that persists a durable error event and fails the run visibly — a control-path bug must never become an unhandled rejection that kills the process while the goal shows `running`.

### D4. Spec budget exhaustion blocks the change, arms re-planning, and leaves the goal running

`blockChangeAndGoal` splits: the spec-budget path calls a new change-scoped block that (a) durably records `change.blocked` with the exhausted-budget reason, (b) leaves goal status untouched, and (c) returns a rejection observation telling the supervisor the change is dead scope and the recovery route is reassess → next-epoch re-plan. The reassessment timing gate changes from "every change archived" to "every change archived or blocked", and an unsatisfied reassessment over blocked scope must reference the blocked change in its structured gaps (validated per D5). Goal-terminal blocking now happens only through the macro-loop bounds (budget, breaker) — which is exactly the loop's job.

*Alternative — keep goal-terminal blocking:* rejected; it contradicts multi-epoch planning's purpose and turns three bad spec attempts into total loss. *Alternative — auto-open a next epoch on block:* rejected; epoch admission must stay supervisor-initiated and reassessment-gated (existing AC3 invariant).

### D5. Remaining gaps are structured; breaker identity is the sorted ref-set

`managed_goal.reassessment.remainingGaps` becomes `[{ refs: string[], summary: string }]`. Each ref must resolve, exactly, to a durable artifact: a change id from any epoch of this goal, a registered task id, or an existing capability name under `openspec/specs/`; a gap proposing genuinely new scope uses a `new:<kebab-case>` ref. Unknown refs reject the control block with a safe reason listing the valid ref universe. The circuit-breaker signature is the sorted, deduplicated union of ref-sets of consecutive unsatisfied reassessments; equality blocks the goal. Prose summaries are stored for observability and never compared.

*Why refs over prose:* prose equality is trivially bypassed (reproduced in REPRO-H6) and fuzzy matching is non-deterministic enforcement — both violate "prompt text is not enforcement". Ref renaming (`new:auth-v2` after `new:auth`) can still evade the breaker, but the epoch budget remains the hard bound, and refs to real artifacts (the common case for stuck goals) cannot be renamed. *Alternative — durable-ledger-derived gaps:* rejected; after an epoch archives its changes the ledger is clean, so it cannot represent semantic gaps at all.

## Risks / Trade-offs

- [BREAKING control-block schema for reassessment] → prompt contract updated in the same change; plain-string gaps rejected with a teaching safe reason; dev-only SQLite means no production migration, and the reset is recorded in tasks.
- [Supervisor may approve a truncated (12k-cap) packet] → truncation marker is explicit in the packet; accepted for v1, noted for follow-up.
- [`new:` refs allow breaker evasion by renaming] → epoch budget still bounds the loop; evasion requires inventing new scope names each epoch, which the durable event trail makes visible for diagnosis.
- [Blocked-change goals can now run longer before terminating] → bounded by the unchanged epoch budget; each extra epoch requires a validated reassessment.
- [Branch divergence: `codex/supervisor-spec-approval` predates 13 master commits] → implementation treats the branch as reference material, not a merge source; requirements here are authoritative and include the D2/D3 corrections the branch lacks.

## Migration Plan

1. Land backend validators + registries + rehydration with tests (TDD; repro tests become the acceptance tests, adapted to the structured-gap schema for H6).
2. Update the supervisor prompt contract last (informational).
3. Reset dev SQLite state in the same task group; no rollback path is needed for dev-only data (documented in tasks.md).

## Open Questions

- None blocking. Follow-ups noted, not spec'd here: packet-size negotiation for large specs; whether judge decisions should surface into the review packet on corrective attempts.
