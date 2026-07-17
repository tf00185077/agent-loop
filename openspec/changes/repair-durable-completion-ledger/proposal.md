## Why

Managed goals can exhaust supervisor continuations and become `blocked` even after every managed task is `accepted`. A restart-time backfill currently replays ignored task-contract mutations into established tasks, while completion evaluation treats Judge-rejected historical candidates as undelivered work; together these defects create durable completion gaps that the supervisor cannot legally repair.

## What Changes

- Replace unconditional startup backfill with a versioned, one-time, re-entrant migration that distinguishes legacy databases from already-initialized managed-task ledgers.
- Preserve the first authoritative frozen task contract across restart, exclude criteria from explicitly ignored mutation events, and repair only existing contract corruption whose provenance can be proven.
- Define delivery obligation from durable Judge and delivery state: an accepted delivery-eligible candidate with attested changes must be committed, while rejected, blocked, malformed, superseded, or otherwise terminal non-deliverable candidates do not create permanent completion gaps.
- Scope every completion-evaluator attempt, review, delivery, and integration lookup to the owning Goal as well as the goal-local logical task identifier.
- Preserve existing terminal `blocked` Goals during migration; ledger repair must not silently resume, complete, or otherwise change their lifecycle state, and any later recovery requires an explicit operator-controlled action.
- Add test-first persistence, evaluator, restart, cross-Goal isolation, and product-level staged-pipeline coverage, including repeat-open migration checks and rejected-attempt retry completion.
- Clarify supervisor guidance so backend-created synthetic spec tasks are not re-announced with conflicting acceptance contracts.

## Capabilities

### New Capabilities

None. This change repairs and sharpens existing durable orchestration contracts.

### Modified Capabilities

- `durable-managed-task-state`: Make historical backfill versioned, provenance-aware, one-time, re-entrant, and safe for existing terminal Goals while preserving immutable task contracts.
- `review-merge-worktree-gate`: Define which reviewed candidates create a delivery obligation and explicitly exclude Judge-rejected or otherwise non-deliverable historical candidates.
- `supervisor-goal-orchestration`: Require Goal-scoped completion evaluation, safe completion of accepted retries, accurate continuation outcomes, and unambiguous handling of synthetic spec tasks.

## Impact

- SQLite initialization and migration logic, including schema-version bookkeeping and historical managed-task repair.
- Managed completion evaluation queries and structured gap semantics.
- Supervisor bootstrap/continuation guidance for planned changes and synthetic spec tasks.
- Persistence, evaluator, restart-rehydration, manager orchestration, prompt, and product-level tests.
- Existing REST and provider control-block shapes remain compatible; no new dependency, automatic terminal-Goal state transition, archive behavior, distributed-worker behavior, or source implementation is part of this proposal.
- The completed `scope-managed-task-identities` change remains authoritative for opaque task identities and goal-local logical IDs; this change adds completion-query isolation without reopening that identity migration.
