# Design: Executable Acceptance Checks

## Context

Result authenticity in the managed loop has three layers: execution integrity (did the claimed check actually run and pass), oracle quality (does the check test the change), and intent alignment (is it what the user wanted). Today all three rest on LLM claims and LLM cross-review. This change makes layer 1 fully deterministic and closes the two cheapest gaming vectors in layer 2, reusing existing machinery: frozen contracts (criteria), attestation allowlists (worker diffs), worktree isolation, and durable criterion outcomes (`managed_task_criteria.outcome` already exists).

Constraints: prompt text is not enforcement; degrade visibly; provider output sanitized before persisting; the backend owns all side effects.

## Goals / Non-Goals

**Goals:** backend-executed checks with durable evidence; deterministic red-green/regression discrimination; protected-path enforcement; executed outcomes outrank judge prose; optional per criterion (incremental adoption).

**Non-Goals:** adversarial test authorship; mutation testing; sandboxing; human sign-off; forcing every criterion to carry a check.

## Decisions

### D1. Check shape, authored by the supervisor, frozen with the contract

```
check?: {
  kind: "red_green" | "regression" | "command",
  command: string,            // run via the project shell in the worktree root
  timeoutMs?: number,         // default 120000, capped
  protectedPaths?: string[],  // repo-relative; worker diffs may not touch these
}
```

Authored in the `managed_delegation.task_list` block, validated deterministically, and frozen exactly like criterion text (restated checks are ignored with the existing mutation-ignored bookkeeping). *Why supervisor-authored:* the supervisor already owns contract authorship; a separate test-author role is the later hardening step, not the entry point.

### D2. Execution happens at review time, backend-owned, per attempt

When a review-merge is dispatched for a worker attempt whose task has checked criteria, the backend runs each check in the worker's worktree **before** the judge child starts, records one durable execution row per (criterion, attempt) — command, kind, exit code, duration, sanitized truncated output (2k cap) — and stamps the criterion outcome: exit 0 → `PASS`, nonzero → `FAIL`. The judge packet includes the execution table so the judge reasons from observed results. A check that cannot start (missing command, timeout) records a visible `check.execution_failed` outcome treated as FAIL — degrade visibly, fail closed.

*Alternative — execute at worker-completion time:* rejected; review time is when the attested diff is final and it keeps one execution per judged attempt.

### D3. Red-green baseline probe

For `kind: "red_green"`, the backend also runs the command against the baseline — a temporary worktree at the supervisor's current HEAD (the same base the worker branched from; reuses the worktree service). Baseline PASS means the check does not discriminate this change (vacuous or unrelated test): the attempt is rejected with a teaching reason naming the check and both results. For `kind: "regression"`, the polarity flips: baseline must PASS and candidate must PASS (protects refactors); baseline FAIL is a contract-authoring error surfaced verbatim. `kind: "command"` runs candidate-only (escape hatch for checks with no meaningful baseline, e.g. linting a new file).

*Why this is the load-bearing anti-gaming move:* `assert true` tests, tests unrelated to the change, and pre-existing green suites all pass on the baseline and are rejected without any LLM judgment — TDD's red light, enforced deterministically.

### D4. Protected paths gate on the attested diff

Before delivery preparation, the backend intersects the attempt's backend-attested files with the union of the task's `protectedPaths`. Non-empty intersection → deterministic rejection naming the files: whoever must pass a check cannot edit the check. This reuses the attestation machinery verbatim and closes the "worker rewrites the test file" vector. Protected paths that do not exist at contract time are permitted (the check may create them via a prior task) but a warning event is recorded.

### D5. Executed outcomes are authoritative for checked criteria

The judge's `managed_review.decision` remains required, but for a checked criterion the backend overwrites the judge's entry with the executed outcome when they disagree, records a durable `check.judge_overridden` event naming both, and a judge `accepted` verdict over any executed FAIL downgrades to rejected. Unchecked criteria keep today's judge-decided flow untouched.

## Risks / Trade-offs

- [Check commands are arbitrary shell] → same trust level as the worker CLI that already runs unsandboxed in the same worktree; no new privilege. Sandboxing is an explicit separate concern.
- [Baseline runs cost a worktree + a command per checked attempt] → bounded by timeout cap; baseline worktrees are ephemeral and reclaimed by the existing orphan-reclaim path.
- [Supervisor authors weak checks] → red-green rejects the vacuous class; residual weakness is the documented L2 gap until adversarial authorship lands.
- [Flaky checks] → a flaky FAIL burns an attempt; the existing retry budget applies. Deterministic reruns are a possible follow-up (single retry on timeout only).
- [Windows shell variance] → commands run through the same spawn conventions as the delivery validation command already does.

## Migration Plan

Additive schema (new optional column/table); no reset required. Prompt contract updated last. Existing prose-only contracts behave exactly as before.

## Open Questions

- None blocking. Follow-ups deliberately deferred: adversarial test-author role; mutation probes; per-goal check-time budget.
