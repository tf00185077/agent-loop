# Design: add-goal-scale-decomposition

## Context

Two archived changes built the execution layers below this one: `wire-managed-supervisor-end-to-end` (supervisor loop, control blocks, continuations) and `add-task-acceptance-contracts` (frozen per-task criteria, cite-only review, structured attested results, narrowing rule). Both live smokes converged for two-task goals, but the architecture still has exactly one decomposition tier — a flat task list. This change adds the goal→changes tier using OpenSpec as the artifact format, under the same division of labor the previous changes validated: **contract formats in prompts, deterministic enforcement in backend validators, LLM work as contracted delegations**.

Key decision already settled in discussion: agents do NOT load the OpenSpec skill or run the CLI. OpenSpec decomposes into (1) a markdown file format any agent can read/write, (2) a CLI the backend spawns as a validator (like git for worktrees/attestation), and (3) skills for interactive orchestrators — a role the backend already fills.

## Goals / Non-Goals

**Goals:**

- Oversized goals split into ordered OpenSpec changes; small goals keep the flat task-list flow with zero new overhead.
- Spec content authored by a contracted spec-writer worker with machine-verifiable acceptance; spec artifacts land in the goal workspace only through review-merge.
- Backend owns scaffold/validate/archive; `openspec` CLI optional with visible degradation.
- One active change at a time; change completion requires done tasks plus merged evidence; goal completion requires all changes archived.

**Non-Goals:**

- Parallel changes/children; nested delegation.
- Semantic/quorum review of spec content (structural gates only in v1).
- Applying OpenSpec artifacts to goals whose workspace is not a git repo (degrade to durable events).
- Owner-remediation/watchdog loops.

## Decisions

### 1. `managed_change.plan` is lightweight; artifacts are authored by a spec-writer delegation

The plan block carries only `changes: [{id, title, rationale, dependsOn?}]`. Supervisor single-turn output is good enough for naming and ordering changes; it is not good enough for rich specs (interactive skill sessions iterate — a one-shot JSON cannot). So accepting a plan auto-registers one synthetic task per change, `spec:<changeId>`, in the existing task registry with frozen backend-authored criteria:

- `S1`: `openspec validate <changeId> --strict` passes (or degraded structural checks).
- `S2`: every requirement has at least one WHEN/THEN scenario.
- `S3`: every task in `tasks.md` carries acceptance criteria.

The supervisor delegates `spec:<changeId>` like any worker task. The spec-writer works in a worktree, can explore the codebase, writes `openspec/changes/<changeId>/*`, and reports via `managed_task.result`. Everything downstream — cited rejection, narrowing, attestation — is inherited for free, and this task's acceptance is unusually objective. **Alternative rejected:** full artifact content inside the control block (shallow, single-turn-bounded, giant JSON).

### 2. The `openspec` CLI is a backend validator with visible degradation

An `openspec-workspace-service` wraps detection (via the existing reusable `cli-command-detection`, configured for `openspec`), `init`/scaffold, `validate --strict`, and `archive`, executed with `spawnSync` in the goal workspace — the same pattern as git worktree/attestation. When the CLI is undetectable: record `runtime.openspec_unavailable` once per goal, render scaffolding from internal templates, replace `validate` with internal structural checks (S2/S3 are internal checks anyway; S1 degrades to markdown-shape checks), and replace `archive` with a directory move + durable event. Never silent, never blocking.

### 3. Deterministic plan budgets in the validator; scale judgment in the prompt

Machine-checkable rules live in `validateManagedControlEvent` + change registry: 2–8 changes per plan, unique ids, `dependsOn` references exist and are acyclic, plan only accepted before any change is active, one plan per goal (v1; re-planning is a follow-up). Semantic sizing guidance (proof-obligation split triggers, soft limits from the staged-delivery skill) goes in the bootstrap prompt as advice — v1 explicitly does not pretend to machine-check semantic size, and does not quorum-vote the plan (deferred).

### 4. Change sequencing mirrors one-active-child

A change registry (per goal, beside the task registry) tracks `planned → specifying → executing → merging → archived | blocked` per change. Enforcement: worker/task-list control events carrying a `changeId` other than the active change are rejected with a safe reason naming the active change; the next change activates only when the previous archives. Task lists announced while a change is active are tagged with that `changeId` (explicit mismatch → rejected; absent → inherited).

### 5. Change completion = tasks done + merged evidence + archive

A change may archive when: all its registered tasks are `done` (or `split` with done descendants), and — if any of its workers produced non-empty attested file changes — at least one successful `review_merge` (`merged` outcome) occurred for those results after the last such worker result. This closes the known gap from both live smokes (files stranded in worktrees / supervisor hand-editing): under a change plan, unmerged worker output cannot be declared delivered. The backend performs the archive and emits `change.archived`; `managed_delegation.complete` is rejected with a safe reason while unarchived planned changes remain. Flat-task-list goals (no plan) keep today's completion semantics — the stricter gate rides the tier that exists for big goals.

### 6. Spec-writer prompt appendix = templates, not the skill

The delegation prompt for `spec:<changeId>` appends: the change's title/rationale/dependsOn context, target paths, minimal proposal/specs/tasks templates with one filled example (≈60 lines), and the S1–S3 criteria — provider-neutral markdown authoring instructions. The OpenSpec skill (CLI workflow guidance) is never loaded into any agent.

### 7. Worktree spec artifacts flow through review-merge like code

Materialized scaffolding is committed to the goal workspace by the backend before spec-writer dispatch (worktrees branch from HEAD — uncommitted scaffolding would be invisible to the worker). The spec-writer's authored artifacts return via the standard worktree → review_merge path. Validation (S1) runs against the worktree copy at result time (pre-merge gate) and again post-merge before the change may progress.

## Risks / Trade-offs

- [Backend committing scaffolding mutates the user's repo] → Scaffolding commits are small, prefixed (`openspec: scaffold <changeId>`), and only occur for goals whose workspace already opted into managed execution; degraded mode (events-only) applies when the workspace is not a git repo.
- [Supervisor plans badly (too few/many changes)] → Budgets bound the range; rationale is durable; re-planning after a blocked change is a follow-up (v1: blocked change → blocked goal with reason).
- [Spec-writer produces valid-but-vacuous specs] → Same residual risk as task criteria; S2/S3 force structure; semantic quorum review deferred.
- [`openspec archive` CLI behavior differs across versions] → Wrap behind the service; degraded move is the fallback on any CLI failure, recorded durably.
- [Change registry is in-memory like the task registry] → Same mitigation as before: every transition is event/row-persisted; orphan recovery fails non-terminal goals on restart; event-sourced rebuild deferred.

## Migration Plan

1. Domain types + `managed_change.plan` validation + `changeId` on task lists/delegations (additive column).
2. `openspec-workspace-service` with CLI detection, scaffold, validate, archive, degradation.
3. Change registry + sequencing/budget validators + completion/archive gating in the session manager.
4. Spec-writer synthetic tasks + prompt appendix + worktree validation hook.
5. Prompt contract (scale assessment, change plan format) + change history in continuations.
6. Mock e2e (plan → spec-writer → validate gate → tasks → merged evidence → archive ×2 → completion), full verification, README, live Codex smoke with an intentionally larger goal.

Rollback: all fields additive; goals without a change plan never touch the new paths.

## Open Questions

- Should scaffolding commits be squashed/reverted if the change ends blocked (v1: leave history, record reason)?
- Minimum goal size worth a plan: leave entirely to supervisor judgment, or add a backend hint (task-count threshold) in the nudge prompt (v1: judgment only)?
