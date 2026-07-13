# Verification: add-goal-scale-decomposition

## Automated verification (2026-07-13)

- `npm test`: 413 tests, 0 failures (14 pre-existing skips — live-CLI-gated
  suites). Covers plan validation/budgets, the OpenSpec workspace service in
  CLI and degraded modes, plan acceptance (scaffold + spec-task registration +
  activation), changeId inheritance/mismatch rejection, spec-writer appendix
  content, pre-merge worktree validation with S-criteria citations, post-merge
  spec approval, archive gating on merged evidence, the completion gate, and
  the full mock-adapter change lifecycle reconstructable from durable events.
- `npm run typecheck`: clean.
- `openspec validate add-goal-scale-decomposition --strict`: valid.

## Live Codex smoke A (task 7.4, 2026-07-13) — findings run

Goal `46c02b67` ("Documentation kit with two staged deliverables") on the
real Codex CLI (`codex-cli 0.144.3`, model label `gpt-5.5`), in a scratch git
workspace with a fresh database.

**What worked on the first real run:**

- The supervisor assessed scale unprompted ("large enough that ordered
  changes...") and emitted a valid `managed_change.plan` on its first turn:
  `product-overview` and `developer-guide` with a correct `dependsOn` edge
  and accurate rationales.
- The backend registered the plan, scaffolded both changes from internal
  templates, and committed them (`openspec: scaffold <changeId>` × 2) so
  child worktrees could see them; `change.activated` fired for
  `product-overview`; both `spec:<changeId>` tasks were registered with
  frozen S1–S3 criteria and the plan event carried scaffold results.
- The first spec-writer delegation dispatched with the spec-writer appendix
  and the frozen contract.
- The pre-merge validation gate fired for real: the spec-writer's result
  claimed success, the backend validated the worktree copy, found no spec
  files and no tasks, and recorded a substantive rejection citing S1/S3 with
  the raw `openspec validate --strict` failure text — exactly the designed
  citation shape.

**Defects found (all fixed and unit-tested in `ed39ce6`):**

1. **Cross-change task lists diluted sequencing.** The supervisor announced
   one task list spanning both changes; inherit-tagging registered the later
   change's tasks (including `spec:developer-guide`) under the active change,
   which would have let out-of-order work through and coupled the first
   change's archive to the second change's tasks. Fix: tasks already owned by
   another change keep their ownership; delegating them while inactive is
   rejected naming the active change.
2. **Backend validation rejections were double-counted.** The rejection
   prompt teaches the supervisor to cite failing criteria; its corrective
   re-delegation citing S1–S3 was classified as a second substantive
   rejection, so one real failure burned the whole retry budget and tripped
   the narrowing rule. Fix: spec tasks are exempt from the re-delegation
   citation classifier — the backend already records their rejections
   deterministically at validation time.
3. **Narrowing demanded an impossible split.** The retry-budget rejection
   told the supervisor to split `spec:product-overview` into narrower tasks —
   but change approval keys on that exact task id, so a split could never
   unblock the change (observed consequence: the supervisor started hand-
   editing the workspace instead). Fix: exhausting a spec task's budget now
   blocks the change and the goal durably (`change.blocked` + `goal.blocked`),
   the v1 rule from the design.
4. **Codex children could not write files.** The adapter inherited the
   machine's codex sandbox default, which was read-only here — the spec
   writer "succeeded" without being able to create files, silently stranding
   every file-producing delegation. Fix: managed sessions pin
   `--sandbox workspace-write` (workers write only inside their isolated
   worktree cwd, matching the design's isolation rule).

Smoke A was cancelled after the findings were captured (the session predated
the fixes).

## Live Codex smokes B–E (task 7.4, 2026-07-13/14) — iterative verification

The same deliberately larger goal was re-run after each fix round, in fresh
scratch workspaces. Every run produced a correct plan (2 changes, `dependsOn`
edge, committed scaffolds, spec tasks with frozen S1–S3) on the supervisor's
first turn — the plan tier itself was solid from run one.

**Smoke B** — with `--sandbox workspace-write` pinned, the spec-writer
authored real artifacts in its worktree (Smoke A's empty-worktree failure
gone). Pre-merge validation rejected them citing S1 only (no double-count):
the artifacts lacked OpenSpec delta section headers, which the appendix never
taught and the strict CLI requires. Fixed in `1c85ce3` (appendix + internal
checks teach/require `## ADDED Requirements`; validation failures are echoed
into the supervisor's continuation observation).

**Smoke C** — spec validation passed (delta fix held). The supervisor then
could not request a review-merge at all and burned all 10 continuations on
rejections until the goal blocked. Root causes, fixed in `f7871ff`:
- the continuation observation never carried the worker delegation id the
  contract tells the supervisor to reference; worker outcomes now append
  `[workerDelegationRequestId: <id>]`;
- `requireWorkerResult` searched only the requesting session's delegations,
  but codex continuations are fresh sessions — it now searches the goal's
  whole supervisor lineage.
Smoke C/D also showed implementation tasks dispatching while the change was
still `specifying` (prompt-only rule); now rejected deterministically naming
the spec task to deliver first (`8031995`).

**Smoke D/E** — the full front half of the lifecycle now works live: plan →
scaffold commits → contracted spec-writer (validated in the worktree, zero
spurious rejections) → cross-session review-merge request accepted and the
review child dispatched into the goal workspace. The runs then stalled on a
**pre-existing platform gap**: no real provider ever emits the
`reviewMergeApplyOutcome` metadata the coordinator keys on — it exists only
between the coordinator and mock test handles (`git log -S` shows no provider
producer ever existed). A real review child applies changes but its outcome
is never captured, so `recordMerged`/spec approval never fire and the applied
-but-uncommitted workspace fails the next clean-workspace checkpoint. This
also explains the earlier acceptance-contracts smoke note that review merges
were "supervisor-optional" and never exercised live.

**Net live evidence for this change:** every new deterministic gate fired
correctly under a real provider (plan budgets, scaffold+activation, frozen
spec contracts, pre-merge validation with criteria citations, sequencing
rejections, specifying gate, completion rejection naming unarchived changes,
continuation change history). The change-archive tail (spec approval →
executing → archive → next change → completion) is proven by the mock e2e
and is unreachable live until review-merge outcomes are real — the follow-up
below.

## Known limitations / follow-ups

1. **Blocking follow-up — derive review-merge outcomes deterministically.**
   Real review children never report `reviewMergeApplyOutcome`; the backend
   should derive the outcome from the checkpoint (workspace diff + fixed
   test via the existing verification service) and own the commit/revert,
   instead of trusting child-emitted metadata that no provider produces.
   Until then, live change archives cannot happen.
2. Change registry state (like the task registry) is in-memory; durable
   events preserve the audit trail and orphan recovery fails non-terminal
   goals on restart. Event-sourced rebuild stays deferred.
3. Blocked change → blocked goal is the v1 rule; re-planning after a blocked
   change is a follow-up.
4. Spec content quality beyond structure (S2/S3) is not judged; semantic
   quorum review stays deferred.
