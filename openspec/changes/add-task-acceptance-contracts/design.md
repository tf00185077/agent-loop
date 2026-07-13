# Design: add-task-acceptance-contracts

## Context

The managed supervisor loop (archived `wire-managed-supervisor-end-to-end`) works end to end but delegates on faith: tasks are `{id, title}`, results are free-text summaries, review standards live in the reviewer's context window, and nothing bounds re-delegation of the same task. The live Codex smoke showed the consequences: repeated re-decomposition of task-1, and a completion claim grounded in worker self-reports rather than attested evidence. The user's pipeline skill (`autonomous-staged-change-delivery`) contributes battle-tested rules for exactly this: frozen acceptance IDs, cite-only review, machine results, and a recovery-shrinking rule. This change ports those **invariants** onto auto-agent's existing SQLite/event control plane (not the skill's file-based state substrate).

## Goals / Non-Goals

**Goals:**

- One frozen acceptance contract per task, referenced by worker, reviewer, and supervisor alike.
- Deterministic enforcement in the backend: missing contracts, uncited verdicts, and third identical-scope retries are rejected by validators, not discouraged by prompts.
- Evidence over self-report: backend attests `files_changed` from the worker worktree.
- Continuations that remember: task history with acceptance status replaces from-scratch re-decomposition.

**Non-Goals:**

- Goal→multiple-OpenSpec-change decomposition (sizing budgets, READY/SPLIT/BLOCKED preflight) — next change.
- Owner-remediation loops, watchdogs, circuit breakers beyond the narrowing rule.
- Parallel children, nested delegation, quorum spec review.
- Changing the review_merge fixed-test gate mechanics (it stays; verdicts gain citations).

## Decisions

### 1. Acceptance contract shape: frozen IDs + binary text, carried in control blocks

Task list entries become `{id, title, acceptance: [{id: "A1", text: "binary, testable condition"}]}`; a worker `managed_delegation.request` for a known `taskId` must reference that task's criteria (the backend injects the frozen copy from its registry — the supervisor cannot silently rewrite criteria on re-delegation). Criterion IDs are immutable per task. **Alternative considered:** free-form acceptance text per delegation — rejected: unstable identity is exactly what lets standards drift between rounds.

### 2. A durable per-goal task registry derived from control events

The backend maintains task state (criteria, status, delegation lineage, rejection count, remaining gaps) keyed by goalId+taskId. v1 keeps the registry in the session-manager state map with every transition also persisted as event metadata, plus acceptance/result JSON on the delegation-request row — the durable rows/events remain the source of truth for rebuild, mirroring how completion/continuation state works today. No new table.

### 3. Structured machine results, with backend-attested file evidence

`AgentRuntimeDelegationSummary` grows optional structured fields: `criterionEvidence: [{criterionId, evidence}]`, `tests: [{command, exitCode, summary}]`, `filesChanged: string[]`. Children report the first two through a `managed_task.result` control block in their final output; `filesChanged` is **never** taken from the child — at child terminal, the delegation coordinator runs `git status --porcelain` in the worker worktree and records the attested paths. Mismatch between claimed and attested scope is recorded durably. **Alternative:** trust child-declared files — rejected; that is the hole the live smoke exposed.

### 4. Cite-only review with deferred findings

A review verdict (from `review_merge` output or a worker-result rejection by the supervisor) must cite existing criterion IDs to count as a substantive rejection. Verdict text referencing no known criterion is recorded as `deferred_finding` metadata — durable, visible, non-blocking. This is a validator rule in the control plane: uncited "reject" cannot flip a task to failed.

### 5. Two-substantive-rejection narrowing rule (in the validator, not the prompt)

Per task, the backend counts substantive rejections (cited-criterion failures). On the third worker delegation for a task whose rejection count ≥ 2 with unchanged criterion scope, the backend rejects the delegation with a safe reason instructing the supervisor to split: re-delegate only the failing criteria as new, strictly narrower tasks (fewer criteria than the failed set) or mark the task failed and re-plan. Narrower re-delegations reset lineage under new task IDs while events preserve the parent-task link. This ports the skill's recovery-shrinking rule: budgets don't merely stop work, they force smaller contracts.

### 6. Continuation prompts carry the task history

`buildSupervisorPrompt` continuation/nudge variants gain a task-history section rendered from the registry: each task's id, title, status (`pending/delegated/accepted/rejected/split/failed/done`), criterion pass/fail status, and last outcome summary. The bootstrap variant documents the acceptance rules (criteria required per task, IDs frozen, citations required). Prompt text informs; validators enforce.

### 7. Enforcement points (all deterministic, all in code)

| Rule | Enforcement point |
|---|---|
| Worker delegation for known task without/with-mismatched acceptance | `validateManagedControlEvent` + session-manager task registry → `delegation.rejected` |
| Third identical-scope retry after 2 substantive rejections | session manager before coordinator dispatch → `delegation.rejected` with split instruction |
| `filesChanged` attestation | delegation coordinator at child terminal (worktree `git status`) |
| Uncited rejection → deferred finding, not a blocker | result-processing validator in session manager |
| Criterion IDs immutable | registry injects frozen copy; attempts to alter are recorded and ignored |

## Risks / Trade-offs

- [Supervisor writes vacuous criteria ("works well")] → Prompt requires binary/testable phrasing with examples; v1 accepts that semantic quality is not machine-checkable (quorum spec review is future work). The structure still stops drift and ping-pong even when criteria are mediocre.
- [Registry lives in memory; restart loses counts] → Every transition is also event/row-persisted; on restart, non-terminal goals already fail via existing orphan recovery, so lost in-memory counts cannot cause unbounded retry today. Full event-sourced rebuild is deferred.
- [Children never emit `managed_task.result` blocks] → Terminal outcome falls back to today's safeSummary path; criterion evidence is then empty and the supervisor must judge — degraded but not broken. Prompts for workers include the result-block format.
- [Attestation cost] → One `git status --porcelain` per child terminal; negligible.
- [Tasks without registered taskId (ad-hoc delegations)] → Allowed but recorded as `uncontracted: true`; the narrowing rule still applies per synthetic lineage so ad-hoc loops are bounded too.

## Migration Plan

1. Domain types + control-event validation (acceptance on task_list/request; `managed_task.result`).
2. Persistence: acceptance/structured-result JSON fields on delegation requests (additive `ensureColumn`).
3. Task registry + enforcement validators in the session manager; coordinator attestation.
4. Prompt variants (contract sections, worker result-block format, continuation task history).
5. Mock-adapter end-to-end test: contract → worker → cited rejection ×2 → forced split → narrower task passes → completion.
6. Docs + full verification; live Codex smoke re-run to compare re-decomposition behavior against the previous run.

Rollback: all fields optional/additive; removing validators restores prior behavior.

## Open Questions

- Should attested-vs-claimed `filesChanged` mismatch beyond a threshold auto-fail the task (v1: record only)?
- Should the narrowing rule's "strictly fewer criteria" check compare criterion text similarity, or is count-based narrowing enough for v1 (v1: count + same-parent lineage)?
