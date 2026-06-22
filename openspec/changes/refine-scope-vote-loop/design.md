## Context

The current iterative runtime can plan, implement, and run a quorum gate after `IMPLEMENT_DIRECTLY`. That gate currently acts as a completion check, but the desired near-term model is simpler: implementation is assigned work, marks its step done, and closes the current work item. A later reviewer module will own post-implementation review.

Scope control is still required before implementation. When the planner repeatedly judges a task as too broad, the runtime needs a bounded refinement loop that asks a small voter panel whether the task still needs decomposition. The vote is a binary scope gate, not a completion or review gate.

## Goals / Non-Goals

**Goals:**

- Remove voting from the `IMPLEMENT_DIRECTLY` path.
- Add explicit type support for scope assessment and binary scope votes.
- Allow planner `too_large` decisions to trigger bounded refinement attempts.
- Carry previous planner and voter reasons into later refinement context.
- Split planner assessment attempts from refinement round limits.
- Block only when the planner explicitly blocks or refinement rounds are exhausted.

**Non-Goals:**

- Do not implement the future reviewer module.
- Do not add a distributed worker or DB-backed task claiming system in this change.
- Do not add abstain or multi-choice vote outcomes.
- Do not add a full work-item tree or sibling-step merge behavior.
- Do not change dashboard architecture beyond existing event visibility.

## Decisions

1. Scope voting is a separate domain concept from completion voting.

   The vote type will represent a binary question: whether the current task is still too large and needs further refinement. `true` means refine again; `false` means accept the current scope and proceed to implementation. This avoids overloading the existing completion-oriented `done` / `not_done` semantics.

   Alternative considered: reuse the existing quorum vote types. That would reduce code churn, but it would mix completion review with scope control and make the later reviewer module harder to separate cleanly.

2. `IMPLEMENT_DIRECTLY` closes the current work item after marking the step done.

   The implementer remains the assigned executor for the current task. When implementation succeeds, the runtime records the step as completed and closes the current work item without asking voters to approve the result.

   Alternative considered: return to the planner after every implementation. That would keep the loop more general, but it would leave completion semantics ambiguous until the reviewer module exists.

3. Planner scope assessment and refinement rounds use separate limits.

   `maxScopeAssessmentAttempts` limits how many times the planner may identify the current task as too large before the runtime asks voters. `maxScopeRefinementRounds` limits how many voter-approved refinement rounds may occur before the runtime blocks and waits for user input.

   Alternative considered: keep using `maxDepth` for all decomposition limits. That is simpler but less precise: planner retry attempts and voter-approved refinement rounds are different failure modes and need separate tests.

4. A negative scope vote proceeds directly to implementation.

   If the voter majority says the task does not need further refinement, the runtime accepts the current scope and enters implementation without asking the planner to reassess scope again. This prevents loops where the planner repeats the same `too_large` decision after voters have rejected further decomposition.

   Alternative considered: ask the planner for another decision after a negative vote. That risks re-entering the same decomposition path with no new information.

5. `too_small` is treated as implementable for this change.

   This change only prevents work items from being too broad. If a planner assessment says a task is too small, the runtime proceeds to implementation instead of introducing merge behavior.

   Alternative considered: model `too_small` as a merge operation. That would require a work-item tree or sibling queue and is outside this scoped change.

## Risks / Trade-offs

- [Risk] Closing after implementation may mark a work item complete before future review semantics exist. -> Mitigation: keep the behavior scoped to the current work item and leave reviewer approval as a future module.
- [Risk] Carrying raw reasons forward can bloat planner context. -> Mitigation: persist and pass a bounded structured summary of the latest planner and voter reasons.
- [Risk] Voters may reject refinement even when the planner believes the task is too large. -> Mitigation: treat the binary vote as authoritative for scope gating and proceed directly to implementation on `false`.
- [Risk] Existing tests may assume post-implementation quorum events. -> Mitigation: update tests to assert scope vote events only on bounded `too_large` paths.
