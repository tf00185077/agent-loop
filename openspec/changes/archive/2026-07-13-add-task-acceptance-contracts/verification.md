# Verification: add-task-acceptance-contracts

## Automated verification (2026-07-13)

- `npm test`: 373 tests, 0 failures (registry unit suite, control-event
  validation, persistence round-trips, manager enforcement/narrowing/review
  classification, structured results + attestation, prompt contract + task
  history).
- `npx tsc --noEmit`: clean.
- `openspec validate add-task-acceptance-contracts --strict`: valid.

## Live Codex smoke (task 6.4, 2026-07-13)

Goal `03cbebf5-cbde-48e4-8f19-10602ae3b092` ("Smoke 3: contracted two-note
goal") ran the same two-task shape as the pre-contract smoke archived with
`wire-managed-supervisor-end-to-end`, on the same real Codex CLI and model.

**Before/after comparison against the pre-contract run:**

| | Pre-contract run | Contracted run |
|---|---|---|
| Durable events | 357 | **60** |
| Task-list announcements | 7 (repeated re-decomposition) | **1** |
| Delegations of task 1 | 6+ | **1** |
| Rejected control blocks | several | **0** |
| Structured worker results | none (free-text claims) | **2/2 with per-criterion evidence** |

Observed evidence:

- First supervisor turn announced the task list **with per-criterion
  acceptance contracts** (`task-alpha-note`/A1, `task-beta-note`/B1) in the
  exact frozen format — no prompting retries needed.
- Both workers received the contract appendix and reported back through
  `managed_task.result` blocks: per-criterion evidence, the exact verification
  command they ran with exit code 0, and claimed files.
- Delegation rows persist the frozen acceptance snapshot; the backend attested
  changed files from each worker worktree independently of the claims.
- Each task was delegated exactly once; continuations carried the task history
  and moved straight to the next task; the goal completed on the explicit
  completion block with an accurate summary.

**Issue found and fixed during verification:** the worktree attestor used
`git status --porcelain`, which collapses a new directory to `docs/` and
produced a false claimed-vs-attested discrepancy. Fixed with `-uall` so
untracked files are listed individually.

## Known limitations / follow-ups

1. `review_merge` remains supervisor-optional: the workers verified their own
   criteria and the supervisor completed without a merge gate, so the files
   exist only in the (pruned) worktrees. Enforcing review-merge before
   completion when workers changed files stays a follow-up (goal→changes
   change).
2. Verdict citation matching is lexical (criterion id token in text); a
   reviewer could cite an id spuriously. Quorum review is future work.
3. The task registry's in-memory counts reset on backend restart; durable
   events preserve the audit trail, and orphan recovery fails non-terminal
   goals, so retries cannot become unbounded — full event-sourced rebuild is
   deferred.
