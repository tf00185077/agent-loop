## Why

A managed task can acquire narrower children without the parent becoming durably `split`. Change archival then evaluates the parent as undelivered while Goal completion treats it as a non-leaf, leaving the Supervisor with no legal control action that can advance the active change and eventually exhausting its continuation budget.

## What Changes

- Make child registration through `parentTaskId` one atomic narrowing transition: validate Goal/change ownership, retry threshold, quiescent parent state, acyclic lineage, and a non-empty strictly smaller child contract; then persist parent `split`, child tasks, and audit evidence together or persist nothing.
- Make SQLite the live authority for narrowing and rehydrate the in-memory task registry only from committed state; the in-memory-only compatibility path uses the same validator and all-or-nothing state plan.
- Introduce one fail-closed lineage projection shared by change archival and Goal completion. Invalid graphs, including a non-`split` parent with children or a `split` parent without children, produce an explicit `invalid_split_lineage` diagnostic instead of being interpreted differently by each gate.
- Persist every attempted archive that cannot proceed as a sanitized `change.archive_blocked` event with the exact blocker class and affected task identifiers.
- Enforce backend ownership of OpenSpec archival: Worker/spec-writer candidates cannot delete an active change, create its dated archive, or mutate archive-owned main specs; backend archive execution uses a write-ahead durable intent and idempotent, fail-closed filesystem/Git reconciliation.
- Add a named, transactional, re-entrant split-lineage migration. Backfill only histories whose parent/child transition is provable; retain ambiguous rows unchanged with bounded diagnostics and preserve terminal Goal lifecycle state.
- Make restart rehydration consume the repaired durable projection and add an explicit dry-run-first operator recovery for eligible existing `blocked` Goals. Recovery never runs during migration or ordinary startup and never resumes ambiguous archive or lineage state.
- Add test-first unit, persistence, migration, restart fault-injection, and real-provider staged-Goal acceptance coverage.
- Keep the maximum continuation count, which turns consume it, reset policy, and terminal budget message unchanged. Any continuation-budget redesign is a separate product decision.

## Capabilities

### New Capabilities

None. This change repairs and aligns existing managed orchestration contracts.

### Modified Capabilities

- `managed-delegation-core`: Treat `parentTaskId` child registration as an atomic, validated narrowing transition and reject invalid or partial lineage.
- `durable-managed-task-state`: Keep durable and in-memory lineage consistent, expose invalid lineage deterministically, migrate only provable historical splits, and preserve safe restart behavior.
- `goal-scale-decomposition`: Use the shared lineage gate for archival, make every archive block durable, enforce backend-only archive mutations, and reconcile interrupted archive side effects idempotently.
- `supervisor-goal-orchestration`: Use the same lineage semantics for Goal completion and define explicit fail-closed recovery of eligible existing blocked Goals without changing continuation-budget policy.

## Impact

- Managed task registration/transition repositories, task cache rehydration, change and completion evaluators, archive orchestration/workspace service, migration bookkeeping, recovery entry point, domain diagnostics, and durable events.
- Focused tests in `src/persistence/` and `src/runtime/agent-session/`, plus database fixtures, restart fault injection, full type/test suites, and a disposable real Codex Supervisor/Worker/Judge staged-Goal E2E.
- Existing provider control-block and REST request shapes remain compatible; `parentTaskId` gains stricter backend validation. Databases and workspaces with ambiguous historical lineage or archive state remain blocked for operator inspection rather than being guessed into progress.
- This is independent of `repair-durable-completion-ledger`: that change repairs candidate delivery obligations and frozen-contract backfill after task outcomes, while this change repairs the earlier lineage transition and archive phase. It reuses the same Goal-scoped durable projection and named migration infrastructure without reopening those fixes.
